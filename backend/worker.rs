//! A dedicated worker thread that runs queued JSON operations through one handler, in order.
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

/// One queued operation with JSON arguments and a channel for its result.
pub(crate) struct Work {
    method: String,
    args: Value,
    reply: oneshot::Sender<Result<Value, String>>,
}
#[derive(Clone)]
/// An asynchronous handle to the dedicated repository worker.
/// Keeps blocking Git, parser and SQLite work off the HTTP runtime threads.
pub(crate) struct Engine {
    sender: mpsc::Sender<Work>,
}
impl Engine {
    /// Moves the handler into a worker thread and creates a queue capped at 32 operations.
    /// The handler receives each operation name and its arguments, and returns the JSON result
    /// or an error message.
    pub(crate) fn start(
        mut handler: impl FnMut(&str, &Value) -> Result<Value, String> + Send + 'static,
    ) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Work>(32);
        std::thread::spawn(move || {
            while let Some(work) = receiver.blocking_recv() {
                let result = handler(&work.method, &work.args);
                let _ = work.reply.send(result);
            }
        });
        Self { sender }
    }
    /// Queues a named repository operation and asynchronously waits for its JSON result.
    /// Returns operation errors or a worker-stopped error if either channel closes.
    pub(crate) async fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Work {
                method: method.into(),
                args,
                reply,
            })
            .await
            .map_err(|_| "Repository worker stopped".to_string())?;
        receive
            .await
            .map_err(|_| "Repository worker stopped".to_string())?
    }
}
