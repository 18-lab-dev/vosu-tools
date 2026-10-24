use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

/// How long a page may take to load or to answer one frame before the render
/// fails with that page's name and what it was waiting for.
const PAGE_DEADLINE: Duration = Duration::from_secs(20);
/// Browser protocol messages: no single step waits longer.
const PROTOCOL_DEADLINE: Duration = Duration::from_secs(45);
/// How long pages wait on real time before their paused virtual time is nudged.
const NUDGE_INTERVAL: Duration = Duration::from_millis(25);
/// Virtual milliseconds one nudge advances.
const NUDGE_BUDGET: f64 = 0.01;

struct Page {
    session: String,
    /// The overlay's display name, for errors.
    name: String,
}

pub struct Driver {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    id: u64,
    events: VecDeque<Value>,
    pages: Vec<Page>,
    last_wall: f64,
    origin: String,
}
impl Driver {
    pub async fn connect(url: &str) -> Result<Self, String> {
        let (socket, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self {
            socket,
            id: 0,
            events: VecDeque::new(),
            pages: Vec::new(),
            last_wall: 0.0,
            origin: String::new(),
        })
    }
    async fn receive(&mut self) -> Result<Value, String> {
        self.receive_until(Instant::now() + PROTOCOL_DEADLINE)
            .await?
            .ok_or_else(|| "Overlay browser protocol timed out".to_owned())
    }
    /// The next protocol message, or `None` once `deadline` passes.
    async fn receive_until(&mut self, deadline: Instant) -> Result<Option<Value>, String> {
        loop {
            let Ok(message) = tokio::time::timeout_at(deadline.into(), self.socket.next()).await
            else {
                return Ok(None);
            };
            let message = message
                .ok_or("Overlay browser disconnected")?
                .map_err(|e| e.to_string())?;
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if value["method"] == "Fetch.requestPaused" {
                    let url = value["params"]["request"]["url"].as_str().unwrap_or("");
                    let allowed = url
                        .strip_prefix(&self.origin)
                        .is_some_and(|path| path.starts_with('/'))
                        || url
                            .strip_prefix("ws://")
                            .zip(self.origin.strip_prefix("http://"))
                            .is_some_and(|(target, host)| {
                                target
                                    .strip_prefix(host)
                                    .is_some_and(|path| path.starts_with('/'))
                            })
                        || url.starts_with("data:")
                        || url.starts_with("blob:");
                    self.id += 1;
                    let mut command = json!({"id":self.id,"sessionId":value["sessionId"],"method":if allowed{"Fetch.continueRequest"}else{"Fetch.failRequest"},"params":{"requestId":value["params"]["requestId"]}});
                    if !allowed {
                        command["params"]["errorReason"] = json!("BlockedByClient");
                    }
                    self.socket
                        .send(Message::Text(command.to_string().into()))
                        .await
                        .map_err(|e| e.to_string())?;
                    continue;
                }
                return Ok(Some(value));
            }
        }
    }
    async fn command(
        &mut self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.id += 1;
        let id = self.id;
        let mut request = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session {
            request["sessionId"] = json!(session);
        }
        self.socket
            .send(Message::Text(request.to_string().into()))
            .await
            .map_err(|e| e.to_string())?;
        loop {
            let response = self
                .receive()
                .await
                .map_err(|error| format!("{method}: {error}"))?;
            if response["id"] == id {
                if let Some(error) = response.get("error") {
                    return Err(format!("Overlay {method}: {error}"));
                }
                let result = response["result"].clone();
                if result.get("exceptionDetails").is_some() {
                    return Err(format!(
                        "Overlay JavaScript: {}",
                        result["exceptionDetails"]
                    ));
                }
                return Ok(result);
            }
            self.events.push_back(response);
        }
    }
    /// `batch` over pages: a page that does not answer is named in the error.
    async fn batch_named(
        &mut self,
        pages: &[Page],
        method: &str,
        params: Value,
    ) -> Result<Vec<Value>, String> {
        let sessions: Vec<String> = pages.iter().map(|page| page.session.clone()).collect();
        let results = self
            .batch_until(
                &sessions,
                method,
                params,
                Instant::now() + PROTOCOL_DEADLINE,
            )
            .await?;
        let silent: Vec<&str> = pages
            .iter()
            .zip(&results)
            .filter(|(_, result)| result.is_none())
            .map(|(page, _)| page.name.as_str())
            .collect();
        if !silent.is_empty() {
            return Err(format!(
                "{}: the page stopped answering {method}",
                silent.join(", ")
            ));
        }
        Ok(results.into_iter().flatten().collect())
    }
    /// One command to every session; `None` for those that did not answer by `deadline`.
    async fn batch_until(
        &mut self,
        sessions: &[String],
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Vec<Option<Value>>, String> {
        let mut ids = Vec::with_capacity(sessions.len());
        for session in sessions {
            self.id += 1;
            ids.push(self.id);
            self.socket
                .feed(Message::Text(
                    json!({"id":self.id,"sessionId":session,"method":method,"params":params})
                        .to_string()
                        .into(),
                ))
                .await
                .map_err(|e| e.to_string())?;
        }
        self.socket.flush().await.map_err(|e| e.to_string())?;
        let mut results = vec![None; sessions.len()];
        let mut remaining = sessions.len();
        while remaining > 0 {
            let Some(mut response) = self
                .receive_until(deadline)
                .await
                .map_err(|error| format!("{method}: {error}"))?
            else {
                break;
            };
            if let Some(index) = response["id"]
                .as_u64()
                .and_then(|id| ids.iter().position(|candidate| *candidate == id))
            {
                if let Some(error) = response.get("error") {
                    return Err(format!("Overlay {method}: {error}"));
                }
                let result = response["result"].take();
                if let Some(exception) = result.get("exceptionDetails") {
                    return Err(format!("Overlay JavaScript: {exception}"));
                }
                results[index] = Some(result);
                remaining -= 1;
            } else {
                self.events.push_back(response);
            }
        }
        Ok(results)
    }
    async fn event(&mut self, session: &str, method: &str) -> Result<(), String> {
        let deadline = Instant::now() + PROTOCOL_DEADLINE;
        loop {
            if let Some(index) = self
                .events
                .iter()
                .position(|event| event["sessionId"] == session && event["method"] == method)
            {
                self.events.remove(index);
                return Ok(());
            }
            let event = self
                .receive_until(deadline)
                .await
                .map_err(|error| format!("{method}: {error}"))?
                .ok_or_else(|| format!("{method}: Overlay browser protocol timed out"))?;
            if event["sessionId"] == session && event["method"] == method {
                return Ok(());
            }
            self.events.push_back(event);
            if self.events.len() > 4096 {
                self.events.pop_front();
            }
        }
    }
    pub async fn add_page(
        &mut self,
        url: &str,
        width: u32,
        height: u32,
        name: &str,
        epoch: f64,
        sequence: u64,
    ) -> Result<(), String> {
        self.open_page(url, width, height, name, epoch, sequence)
            .await
            .map_err(|error| {
                if error.starts_with(&format!("{name}: ")) {
                    error
                } else {
                    format!("{name}: {error}")
                }
            })
    }
    async fn open_page(
        &mut self,
        url: &str,
        width: u32,
        height: u32,
        name: &str,
        epoch: f64,
        sequence: u64,
    ) -> Result<(), String> {
        self.origin = reqwest::Url::parse(url)
            .map_err(|e| e.to_string())?
            .origin()
            .ascii_serialization();
        let target = self
            .command(
                None,
                "Target.createTarget",
                json!({"url":"about:blank","background":true}),
            )
            .await?;
        let target = target["targetId"].as_str().ok_or("No overlay target")?;
        let attached = self
            .command(
                None,
                "Target.attachToTarget",
                json!({"targetId":target,"flatten":true}),
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .ok_or("No overlay session")?
            .to_owned();
        self.command(Some(&session), "Page.enable", json!({}))
            .await?;
        self.command(Some(&session), "Runtime.enable", json!({}))
            .await?;
        self.command(
            Some(&session),
            "Emulation.setDeviceMetricsOverride",
            json!({"width":width,"height":height,"deviceScaleFactor":1,"mobile":false}),
        )
        .await?;
        self.command(
            Some(&session),
            "Emulation.setDefaultBackgroundColorOverride",
            json!({"color":{"r":0,"g":0,"b":0,"a":0}}),
        )
        .await?;
        self.command(
            Some(&session),
            "Emulation.setVirtualTimePolicy",
            json!({"policy":"pauseIfNetworkFetchesPending","initialVirtualTime":epoch/1000.0}),
        )
        .await?;
        let mut script = include_str!("overlay-clock.js").to_owned();
        script.push_str(&format!(
            "\nwindow.__vosuEpoch={epoch};window.__vosuSyncPrefix={};",
            serde_json::to_string(crate::overlays::SYNC_PREFIX).map_err(|e| e.to_string())?
        ));
        self.command(
            Some(&session),
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source":script}),
        )
        .await?;
        self.command(
            Some(&session),
            "Fetch.enable",
            json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
        )
        .await?;
        self.events.retain(|event| {
            !(event["sessionId"] == session && event["method"] == "Page.loadEventFired")
        });
        self.command(Some(&session), "Page.navigate", json!({"url":url}))
            .await?;
        self.event(&session, "Page.loadEventFired").await?;
        let page = Page {
            session,
            name: name.to_owned(),
        };
        self.settle(
            std::slice::from_ref(&page),
            format!("window.__vosuPreloadFonts().then(()=>window.__vosuWait({sequence})).then(()=>window.__vosuIdle())"),
            sequence,
        )
        .await?;
        let session = page.session.clone();
        self.command(
            Some(&session),
            "Emulation.setVirtualTimePolicy",
            json!({"policy":"pause"}),
        )
        .await?;
        self.pages.push(page);
        Ok(())
    }
    /// Evaluates the awaited readiness `expression` on every page; `None` for
    /// pages that did not answer within `PAGE_DEADLINE`.
    ///
    /// Chrome does not complete a WebSocket handshake while a page's virtual
    /// time is paused, so a socket a page opens while it settles (a rolling
    /// subscription, a reconnect) would never connect. While pages have not
    /// answered, virtual time is nudged forward by `NUDGE_BUDGET` every
    /// `NUDGE_INTERVAL`: enough for pending tasks to run, far below a frame.
    /// Page clocks and timers follow the render clock, not virtual time.
    async fn wait_nudging(
        &mut self,
        pages: &[Page],
        expression: &str,
    ) -> Result<Vec<Option<Value>>, String> {
        let mut ids = Vec::with_capacity(pages.len());
        for page in pages {
            self.id += 1;
            ids.push(self.id);
            self.socket
                .feed(Message::Text(
                    json!({"id":self.id,"sessionId":page.session,"method":"Runtime.evaluate","params":{"expression":expression,"awaitPromise":true,"returnByValue":true}})
                        .to_string()
                        .into(),
                ))
                .await
                .map_err(|e| e.to_string())?;
        }
        self.socket.flush().await.map_err(|e| e.to_string())?;
        let deadline = Instant::now() + PAGE_DEADLINE;
        let mut results: Vec<Option<Value>> = vec![None; pages.len()];
        let mut nudged: Vec<String> = Vec::new();
        let mut nudges: Vec<u64> = Vec::new();
        while results.iter().any(Option::is_none) {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let tick = deadline.min(now + NUDGE_INTERVAL);
            let Some(mut response) = self
                .receive_until(tick)
                .await
                .map_err(|error| format!("Runtime.evaluate: {error}"))?
            else {
                for (page, result) in pages.iter().zip(&results) {
                    if result.is_some() {
                        continue;
                    }
                    self.id += 1;
                    nudges.push(self.id);
                    nudged.push(page.session.clone());
                    self.socket
                        .send(Message::Text(
                            json!({"id":self.id,"sessionId":page.session,"method":"Emulation.setVirtualTimePolicy","params":{"policy":"advance","budget":NUDGE_BUDGET}})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .map_err(|e| e.to_string())?;
                }
                continue;
            };
            let id = response["id"].as_u64();
            if let Some(index) = id.and_then(|id| ids.iter().position(|candidate| *candidate == id))
            {
                if let Some(error) = response.get("error") {
                    return Err(format!("Overlay Runtime.evaluate: {error}"));
                }
                let result = response["result"].take();
                if let Some(exception) = result.get("exceptionDetails") {
                    return Err(format!("Overlay JavaScript: {exception}"));
                }
                results[index] = Some(result);
            } else if id.is_some_and(|id| nudges.contains(&id)) {
                if let Some(error) = response.get("error") {
                    return Err(format!("Overlay Emulation.setVirtualTimePolicy: {error}"));
                }
            } else {
                self.events.push_back(response);
            }
        }
        // Every nudge ends in its own budget event: consume them so the frame's
        // own budget wait cannot mistake one for its end.
        for session in nudged {
            self.event(&session, "Emulation.virtualTimeBudgetExpired")
                .await?;
        }
        Ok(results)
    }
    /// Runs a page-readiness `expression` on `pages`; a page that has not
    /// answered by the deadline fails the render with its name and what it
    /// was waiting for (`stall_reason`).
    async fn settle(
        &mut self,
        pages: &[Page],
        expression: String,
        sequence: u64,
    ) -> Result<(), String> {
        let results = self.wait_nudging(pages, &expression).await?;
        let mut reasons = Vec::new();
        for (page, result) in pages.iter().zip(results) {
            if result.is_some() {
                continue;
            }
            let diagnosis = self
                .batch_until(
                    std::slice::from_ref(&page.session),
                    "Runtime.evaluate",
                    json!({"expression":"window.__vosuDiagnose?.()","returnByValue":true}),
                    Instant::now() + Duration::from_secs(3),
                )
                .await;
            let reason = match diagnosis {
                Ok(mut answers) => match answers.pop().flatten() {
                    Some(answer) => stall_reason(&answer["result"]["value"], sequence),
                    None => "the page stopped responding".to_owned(),
                },
                Err(error) => error,
            };
            reasons.push(format!("{}: {reason}", page.name));
        }
        if reasons.is_empty() {
            Ok(())
        } else {
            Err(reasons.join("; "))
        }
    }
    pub async fn capture(
        &mut self,
        sequence: u64,
        wall_ms: f64,
        capture: bool,
    ) -> Result<Vec<String>, String> {
        if wall_ms < self.last_wall {
            return Err("Overlay export clock must be monotonic".into());
        }
        let budget = (wall_ms - self.last_wall).max(0.001);
        self.last_wall = wall_ms;
        let pages = std::mem::take(&mut self.pages);
        let result=async {
        self.settle(&pages, format!("window.__vosuAdvance({wall_ms});window.__vosuWait({sequence}).then(()=>window.__vosuIdle())"), sequence).await?;
        self.batch_named(&pages, "Emulation.setVirtualTimePolicy", json!({"policy":"advance","budget":budget,"maxVirtualTimeTaskStarvationCount":1000})).await?;
        for page in &pages {
            self.event(&page.session, "Emulation.virtualTimeBudgetExpired")
                .await
                .map_err(|error| format!("{}: {error}", page.name))?;
        }
        if !capture { return Ok(Vec::new()); }
        // Capture follows the existing fixed virtual clock, with lossless alpha.
        let screenshots = self.batch_named(&pages, "Page.captureScreenshot", json!({"format":"png","fromSurface":true,"captureBeyondViewport":false,"optimizeForSpeed":true})).await?;
        let mut images = Vec::with_capacity(pages.len());
        for mut image in screenshots {
            let Some(Value::String(data)) = image.get_mut("data").map(Value::take) else {
                return Err(format!("Overlay screenshot missing: {image}"));
            };
            images.push(data);
        }
        Ok(images)
        }.await;
        self.pages = pages;
        // Network/console events are not part of the frame clock and must not accumulate during long renders.
        self.events.clear();
        result
    }
}

/// Why a page did not finish a frame, from its `__vosuDiagnose()` report.
pub fn stall_reason(report: &Value, sequence: u64) -> String {
    let sockets = report["sockets"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    for socket in sockets {
        let path = socket["path"].as_str().unwrap_or("");
        let state = socket["state"].as_str().unwrap_or("");
        if state == "closing" || state == "closed" {
            continue;
        }
        if state == "connecting" {
            return format!("{path} never connected");
        }
        if path == "/websocket/commands" {
            if socket["answered"].as_u64() < socket["asked"].as_u64() {
                return "no response to getSettings".to_owned();
            }
            continue;
        }
        if socket["sequence"].as_i64().unwrap_or(-1) < sequence as i64 {
            let sent = socket["sent"]
                .as_array()
                .is_some_and(|sent| !sent.is_empty());
            return if path == "/websocket/v2/subscribe" && !sent {
                format!("{path} opened but never subscribed")
            } else {
                format!("no {path} update for render frame {sequence}")
            };
        }
    }
    if let Some(fetch) = report["fetches"].as_array().and_then(|f| f.first()) {
        return format!("request {} never finished", fetch.as_str().unwrap_or("?"));
    }
    if report["fonts"] == "loading" {
        return "web fonts never finished loading".to_owned();
    }
    if let Some(error) = report["errors"].as_array().and_then(|e| e.last()) {
        return format!("page error: {}", error.as_str().unwrap_or("?"));
    }
    if report.is_null() {
        return "the page never loaded its render clock".to_owned();
    }
    format!("no answer within {} s", PAGE_DEADLINE.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stalls_name_what_the_page_waited_for() {
        let socket = |path: &str,
                      state: &str,
                      sequence: i64,
                      sent: &[&str],
                      asked: u64,
                      answered: u64| {
            json!({"path":path,"state":state,"sequence":sequence,"sent":sent,"received":answered,"asked":asked,"answered":answered})
        };
        let report = |sockets: Vec<Value>| json!({"sockets":sockets,"fetches":[],"fonts":"loaded","errors":[]});
        assert_eq!(
            stall_reason(
                &report(vec![socket(
                    "/websocket/commands",
                    "open",
                    -1,
                    &["getSettings:x"],
                    1,
                    0
                )]),
                3
            ),
            "no response to getSettings"
        );
        assert_eq!(
            stall_reason(
                &report(vec![socket(
                    "/websocket/v2/subscribe",
                    "open",
                    -1,
                    &[],
                    0,
                    0
                )]),
                3
            ),
            "/websocket/v2/subscribe opened but never subscribed"
        );
        assert_eq!(
            stall_reason(
                &report(vec![socket(
                    "/websocket/v2/subscribe",
                    "open",
                    2,
                    &["[\"/a\"]"],
                    0,
                    0
                )]),
                3
            ),
            "no /websocket/v2/subscribe update for render frame 3"
        );
        assert_eq!(
            stall_reason(&report(vec![socket("/ws", "connecting", -1, &[], 0, 0)]), 3),
            "/ws never connected"
        );
        // Closed sockets and settled ones are not the reason.
        assert_eq!(
            stall_reason(
                &report(vec![
                    socket("/websocket/v2", "closed", -1, &[], 0, 0),
                    socket("/websocket/v2", "open", 3, &[], 0, 0),
                    socket("/websocket/commands", "open", -1, &["getSettings:x"], 1, 1),
                ]),
                3
            ),
            "no answer within 20 s"
        );
        let fetch = json!({"sockets":[],"fetches":["/json/v2"],"fonts":"loaded","errors":[]});
        assert_eq!(stall_reason(&fetch, 1), "request /json/v2 never finished");
        let fonts = json!({"sockets":[],"fetches":[],"fonts":"loading","errors":["x"]});
        assert_eq!(stall_reason(&fonts, 1), "web fonts never finished loading");
        let error =
            json!({"sockets":[],"fetches":[],"fonts":"loaded","errors":["ReferenceError: x"]});
        assert_eq!(stall_reason(&error, 1), "page error: ReferenceError: x");
        assert_eq!(
            stall_reason(&Value::Null, 1),
            "the page never loaded its render clock"
        );
    }
}
