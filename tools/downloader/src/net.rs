use crate::model::Config;
use reqwest::{Client, Response, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::{sync::Mutex, time::Instant};

#[derive(Default)]
pub struct RateLimiter {
    next: Mutex<HashMap<String, Instant>>,
}
impl RateLimiter {
    pub async fn wait(&self, source: &str, spacing: Duration) {
        loop {
            let when = {
                let mut slots = self.next.lock().await;
                let next = slots.entry(source.to_owned()).or_insert_with(Instant::now);
                let now = Instant::now();
                if *next <= now {
                    *next = now + spacing;
                    return;
                }
                *next
            };
            // Recheck after waking: Retry-After can extend an already waiting
            // request's deadline. Cancellation never consumes a future slot.
            tokio::time::sleep_until(when).await;
        }
    }
    async fn defer(&self, source: &str, delay: Duration) {
        let mut slots = self.next.lock().await;
        let next = slots.entry(source.to_owned()).or_insert_with(Instant::now);
        *next = (*next).max(Instant::now() + delay);
    }
}
#[derive(Clone)]
pub struct Network {
    pub http: Client,
    pub limiter: Arc<RateLimiter>,
    cache: PathBuf,
    /// (credential fingerprint, access token, expiry). A credential change in
    /// the dashboard settings invalidates the token on the next request.
    token: Arc<Mutex<Option<(String, String, Instant)>>>,
}
impl Network {
    pub fn new(cache: PathBuf) -> Result<Self, String> {
        let http = Client::builder()
            .user_agent(
                "vosu-tools/0.1.0 beatmap-downloader (+https://github.com/shiruviaa/vosu-tools)",
            )
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|_| "HTTP client initialization failed")?;
        Ok(Self {
            http,
            limiter: Arc::default(),
            cache,
            token: Arc::default(),
        })
    }
    pub async fn request(
        &self,
        url: &str,
        key: &str,
        interval: u64,
        bearer: Option<&str>,
    ) -> Result<Response, String> {
        for attempt in 0..4 {
            self.limiter
                .wait(key, Duration::from_millis(interval))
                .await;
            let mut req = self.http.get(url);
            if let Some(t) = bearer {
                req = req.bearer_auth(t);
            }
            let response = match req.send().await {
                Ok(r) => r,
                Err(_) => {
                    if attempt == 3 {
                        return Err("network request failed".into());
                    }
                    self.limiter
                        .defer(key, Duration::from_secs(2u64.pow(attempt + 1)))
                        .await;
                    continue;
                }
            };
            if response.status().is_success() {
                return Ok(response);
            }
            let status = response.status();
            if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                let delay =
                    retry_after(&response).unwrap_or(Duration::from_secs(2u64.pow(attempt + 1)));
                self.limiter.defer(key, delay).await;
                if attempt < 3 {
                    continue;
                }
            }
            return Err(format!(
                "source returned HTTP {} (no automatic mirror failover)",
                status.as_u16()
            ));
        }
        Err("request retry limit reached".into())
    }
    pub async fn json(
        &self,
        url: &str,
        key: &str,
        interval: u64,
        bearer: Option<&str>,
    ) -> Result<Value, String> {
        let cache = self
            .cache
            .join(format!("{:x}.json", Sha256::digest(url.as_bytes())));
        if let Ok(meta) = std::fs::metadata(&cache)
            && meta
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|a| a < Duration::from_secs(600))
            && let Ok(bytes) = std::fs::read(&cache)
            && let Ok(v) = serde_json::from_slice(&bytes)
        {
            return Ok(v);
        }
        let mut r = self.request(url, key, interval, bearer).await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = r
            .chunk()
            .await
            .map_err(|_| "metadata response interrupted")?
        {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("metadata response exceeds 8 MiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| "source returned invalid JSON")?;
        std::fs::create_dir_all(&self.cache).map_err(|_| "cannot create metadata cache")?;
        crate::store::atomic_bytes(&cache, &bytes)?;
        Ok(value)
    }
    pub async fn official(
        &self,
        path: &str,
        params: &[(String, String)],
        settings: &Config,
    ) -> Result<Value, String> {
        if !settings.credentials() {
            return Err("configure your own osu! API client ID and secret in tool settings".into());
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(format!(
                "{}\0{}",
                settings.client_id, settings.client_secret
            ))
        );
        let token = {
            let mut token = self.token.lock().await;
            if token
                .as_ref()
                .is_none_or(|(key, _, expiry)| *key != fingerprint || *expiry <= Instant::now())
            {
                self.limiter
                    .wait("osu.ppy.sh", Duration::from_secs(1))
                    .await;
                let r=self.http.post("https://osu.ppy.sh/oauth/token").json(&json!({"client_id":settings.client_id,"client_secret":settings.client_secret,"grant_type":"client_credentials","scope":"public"})).send().await.map_err(|_| "OAuth connection failed")?;
                if !r.status().is_success() {
                    return Err("OAuth failed; check your client credentials".into());
                }
                let v: Value = r.json().await.map_err(|_| "invalid OAuth response")?;
                let t = v["access_token"]
                    .as_str()
                    .ok_or("OAuth response has no access token")?
                    .to_owned();
                let expiry = v["expires_in"]
                    .as_u64()
                    .unwrap_or(60)
                    .saturating_sub(30)
                    .min(86400);
                *token = Some((fingerprint, t, Instant::now() + Duration::from_secs(expiry)));
            }
            token.as_ref().unwrap().1.clone()
        };
        let mut url = reqwest::Url::parse(&format!("https://osu.ppy.sh/api/v2/{path}"))
            .map_err(|_| "invalid API path")?;
        url.query_pairs_mut()
            .extend_pairs(params.iter().map(|(k, v)| (k, v)));
        self.json(url.as_str(), "osu.ppy.sh", 1000, Some(&token))
            .await
    }
}
fn retry_after(response: &Response) -> Option<Duration> {
    let s = response.headers().get("retry-after")?.to_str().ok()?;
    s.parse::<u64>().ok().map(Duration::from_secs).or_else(|| {
        httpdate::parse_http_date(s)
            .ok()?
            .duration_since(SystemTime::now())
            .ok()
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn limiter_spaces_and_defers_sources() {
        let l = RateLimiter::default();
        let start = Instant::now();
        l.wait("a", Duration::from_secs(2)).await;
        l.wait("a", Duration::from_secs(2)).await;
        assert_eq!(Instant::now() - start, Duration::from_secs(2));
        l.wait("b", Duration::from_secs(2)).await;
        assert_eq!(Instant::now() - start, Duration::from_secs(2));
        l.defer("a", Duration::from_secs(9)).await;
        l.wait("a", Duration::from_secs(2)).await;
        assert_eq!(Instant::now() - start, Duration::from_secs(11));
    }
}
