use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{collections::VecDeque, time::Duration};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

pub struct Driver {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    id: u64,
    events: VecDeque<Value>,
    pages: Vec<String>,
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
        loop {
            let message = tokio::time::timeout(Duration::from_secs(45), self.socket.next())
                .await
                .map_err(|_| "Overlay browser protocol timed out")?
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
                return Ok(value);
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
    async fn event(&mut self, session: &str, method: &str) -> Result<(), String> {
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
                .receive()
                .await
                .map_err(|error| format!("{method}: {error}"))?;
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
            "\nwindow.COUNTER_PATH={};window.__vosuEpoch={epoch};",
            serde_json::to_string(name).map_err(|e| e.to_string())?
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
        self.command(Some(&session),"Runtime.evaluate",json!({"expression":"window.__vosuWait(0).then(()=>window.__vosuIdle())","awaitPromise":true,"returnByValue":true})).await?;
        self.command(
            Some(&session),
            "Emulation.setVirtualTimePolicy",
            json!({"policy":"pause"}),
        )
        .await?;
        self.pages.push(session);
        Ok(())
    }
    pub async fn capture(&mut self, sequence: u64, wall_ms: f64) -> Result<Vec<String>, String> {
        if wall_ms < self.last_wall {
            return Err("Overlay export clock must be monotonic".into());
        }
        let budget = (wall_ms - self.last_wall).max(0.001);
        self.last_wall = wall_ms;
        let pages = std::mem::take(&mut self.pages);
        let result=async {
        let mut images = Vec::with_capacity(pages.len());
        for session in &pages {
            self.command(Some(session),"Runtime.evaluate",json!({"expression":format!("window.__vosuTime={wall_ms};window.__vosuWait({sequence}).then(()=>window.__vosuIdle())"),"awaitPromise":true,"returnByValue":true})).await?;
            self.command(Some(session),"Emulation.setVirtualTimePolicy",json!({"policy":"advance","budget":budget,"maxVirtualTimeTaskStarvationCount":1000})).await?;
            self.event(session, "Emulation.virtualTimeBudgetExpired")
                .await?;
            let mut image = self
                .command(
                    Some(session),
                    "Page.captureScreenshot",
                    json!({"format":"png","fromSurface":true,"captureBeyondViewport":false}),
                )
                .await?;
            let Some(Value::String(data))=image.get_mut("data").map(Value::take) else {
                return Err("Overlay screenshot missing".into());
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
