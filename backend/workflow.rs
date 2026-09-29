//! Durable review comments, frozen task previews and owner-only verification.
//! State lives outside committed source. SQLite transactions serialize UI and agent reports.
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
/// Repository-scoped workflow store shared by the API, runner and reporting process.
#[derive(Clone)]
pub struct Workflow {
    pub repo: PathBuf,
    pub state: PathBuf,
    pub watched: String,
    pub codex: String,
    pub claude: String,
}
/// Milliseconds since the Unix epoch for audit events, independent of commit dates.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
/// Returns a required, bounded, nonempty text field without changing its content.
pub fn text<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let s = v[key].as_str().with_context(|| format!("Missing {key}"))?;
    ensure!(
        !s.trim().is_empty() && s.len() <= max && !s.contains('\0'),
        "Invalid {key}"
    );
    Ok(s)
}
fn list<'a>(v: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    v[key].as_array_mut().unwrap()
}
fn find<'a>(v: &'a Value, key: &str, id: &str) -> Result<&'a Value> {
    v[key]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == id)
        .context("Not found")
}
fn find_mut<'a>(v: &'a mut Value, key: &str, id: &str) -> Result<&'a mut Value> {
    list(v, key)
        .iter_mut()
        .find(|x| x["id"] == id)
        .context("Not found")
}
/// Appends a complete comment-state event so edits and previous reports remain inspectable.
fn event(c: &mut Value, actor: &str) {
    c["version"] = json!(c["version"].as_u64().unwrap_or(0) + 1);
    c["updatedAt"] = json!(now());
    let mut record = c.clone();
    record.as_object_mut().unwrap().remove("history");
    record["actor"] = json!(actor);
    c["history"].as_array_mut().unwrap().push(record);
}
impl Workflow {
    /// Opens a private database bound to one canonical repository and watched ref.
    pub fn new(
        repo: &Path,
        state: &Path,
        watched: &str,
        codex: &str,
        claude: &str,
    ) -> Result<Self> {
        std::fs::create_dir_all(state)?;
        let this = Self {
            repo: repo.canonicalize()?,
            state: state.canonicalize()?,
            watched: watched.into(),
            codex: codex.into(),
            claude: claude.into(),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&this.state, std::fs::Permissions::from_mode(0o700))?;
        }
        let conn = this.connection()?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS workflow (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);")?;
        conn.execute(
            "INSERT OR IGNORE INTO workflow VALUES (1,?1)",
            [json!({"repo":this.repo,"comments":[],"runs":[]}).to_string()],
        )?;
        this.update(|v| {
            ensure!(
                v["repo"] == json!(this.repo),
                "Workflow state belongs to a different repository"
            );
            Ok(Value::Null)
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                this.state.join("workflow.sqlite"),
                std::fs::Permissions::from_mode(0o600),
            )?;
        }
        Ok(this)
    }
    fn connection(&self) -> Result<Connection> {
        let c = Connection::open(self.state.join("workflow.sqlite"))?;
        c.busy_timeout(Duration::from_secs(10))?;
        Ok(c)
    }
    /// Applies a complete state transition atomically, rolling back validation failures.
    pub fn update(&self, f: impl FnOnce(&mut Value) -> Result<Value>) -> Result<Value> {
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let raw: String = tx.query_row("SELECT body FROM workflow WHERE id=1", [], |r| r.get(0))?;
        let mut v: Value = serde_json::from_str(&raw)?;
        let out = f(&mut v)?;
        tx.execute("UPDATE workflow SET body=?1 WHERE id=1", [v.to_string()])?;
        tx.commit()?;
        Ok(out)
    }
    /// Reads current workflow state. Reporting credentials are hashes and never returned to browsers.
    pub fn read(&self) -> Result<Value> {
        let c = self.connection()?;
        let raw: String = c.query_row("SELECT body FROM workflow WHERE id=1", [], |r| r.get(0))?;
        Ok(serde_json::from_str(&raw)?)
    }
    /// Runs Git with hooks disabled and literal pathspecs;
    /// never changes the inspected checkout.
    pub fn git(&self, args: &[&str]) -> Result<String> {
        let mut a = vec![
            "--no-optional-locks",
            "--literal-pathspecs",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
        ];
        a.push(self.repo.to_str().context("Non UTF-8 repository path")?);
        a.extend_from_slice(args);
        Ok(
            String::from_utf8(crate::process::run("git", &a, None, vec![])?)?
                .trim()
                .into(),
        )
    }
    /// Resolves an explicit commit without accepting Git options.
    pub fn resolve(&self, revision: &str) -> Result<String> {
        ensure!(
            !revision.is_empty() && revision.len() < 256 && !revision.starts_with('-'),
            "Invalid revision"
        );
        self.git(&[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{revision}^{{commit}}"),
        ])
    }
    /// Serves the owner's workflow routes. Dispatch only accepts an unchanged persisted preview.
    pub fn route(&self, method: &str, path: &str, body: Value) -> Result<Value> {
        if method == "GET" && path == "/api/workflow" {
            let mut v = self.read()?;
            for r in list(&mut v, "runs") {
                r.as_object_mut().unwrap().remove("reportHash");
            }
            v["watched"] = json!(self.watched);
            return Ok(v);
        }
        if method == "POST" && path == "/api/comments" {
            let content = text(&body, "text", 12000)?;
            let sha = self.resolve(text(&body, "sha", 256)?)?;
            let anchor = &body["anchor"];
            let kind = text(anchor, "kind", 32)?;
            ensure!(
                ["repo", "folder", "file", "symbol", "edge"].contains(&kind),
                "Invalid anchor kind"
            );
            let path = anchor["path"].as_str().unwrap_or("");
            ensure!(
                path.len() <= 2048
                    && !path.starts_with('/')
                    && !path.split('/').any(|p| p == "..")
                    && !path.contains('\0'),
                "Invalid anchor path"
            );
            if kind != "repo" {
                ensure!(!path.is_empty(), "Missing anchor path");
                self.git(&["cat-file", "-e", &format!("{sha}:{path}")])?;
            }
            ensure!(anchor.to_string().len() <= 6000, "Anchor too large");
            if kind == "symbol" {
                text(anchor, "symbol", 512)?;
            }
            if kind == "edge" {
                text(anchor, "target", 2048)?;
                text(anchor, "relationship", 32)?;
            }
            return self.update(|v| {
                ensure!(v["comments"].as_array().unwrap().len()<10000,"Comment limit reached");
                let mut c = json!({"id":format!("c{}", &crate::random_token()[..16]),"anchor":anchor,"sha":sha,"text":content,"status":"draft","version":0,"createdAt":now(),"history":[]});
                event(&mut c,"owner");
                list(v,"comments").push(c.clone());
                Ok(c)
            });
        }
        if method == "PATCH" && path.starts_with("/api/comments/") {
            let id = path.trim_start_matches("/api/comments/");
            return self.update(|v| {
                let c = find(v,"comments",id)?;
                ensure!(body["version"] == c["version"],"Comment changed; refresh before editing");
                let action = text(&body,"action",32)?;
                if ["verify","reopen","delete"].contains(&action) && let Some(run) = c["runId"].as_str() {
                    ensure!(!active(find(v,"runs",run)?), "Wait for the run to finish");
                }
                if action == "verify" {
                    ensure!(c["status"] == "addressed", "Only addressed comments can be verified");
                    let run=find(v,"runs",c["runId"].as_str().context("Missing run")?)?;
                    self.git(&["merge-base","--is-ancestor",c["report"]["commit"].as_str().context("Missing result commit")?,run["branch"].as_str().unwrap()])?;
                }
                let c = find_mut(v,"comments",id)?;
                match action {
                    "edit" => { ensure!(c["status"] == "draft", "Only drafts can be edited");
                        c["text"] = json!(text(&body,"text",12000)?);
                    }
                    "delete" => { ensure!(["draft","flagged"].contains(&c["status"].as_str().unwrap_or("")),"Only draft or flagged comments can be deleted");
                        c["status"] = json!("deleted");
                    }
                    "reopen" => { ensure!(["addressed","flagged","unreported"].contains(&c["status"].as_str().unwrap_or("")),"This comment cannot be reopened");
                        c["status"] = json!("draft");
                        c["report"] = Value::Null;
                        c["runId"] = Value::Null;
                    }
                    "verify" => { ensure!(c["status"] == "addressed", "Only addressed comments can be verified");
                        c["verification"] = json!({"note":text(&body,"note",12000)?,"commit":c["report"]["commit"],"at":now(),"actor":"owner"});
                        c["status"] = json!("verified");
                    }
                    _ => bail!("Unknown comment action"),
                }
                event(c,"owner");
                Ok(c.clone())
            });
        }
        if method == "POST" && path == "/api/runs/preview" {
            return self.preview(&body);
        }
        if method == "POST" && path == "/api/runs" {
            let id = text(&body, "previewId", 64)?;
            let token = crate::random_token();
            let start = self.resolve(&self.watched)?;
            let run = self.update(|v| {
                let r = find(v, "runs", id)?.clone();
                // Retries return the original run;
                // they never launch another process.
                if r["status"] != "preview" {
                    return Ok(json!({"existing":true,"id":id}));
                }
                ensure!(
                    !v["runs"].as_array().unwrap().iter().any(active),
                    "A run is already active"
                );
                ensure!(
                    r["base"] == start,
                    "Watched branch advanced; preview the task again"
                );
                for snapshot in r["comments"].as_array().unwrap() {
                    let c = find(v, "comments", snapshot["id"].as_str().unwrap())?;
                    ensure!(
                        c["status"] == "draft" && c["version"] == snapshot["version"],
                        "Drafts changed; preview the task again"
                    );
                }
                for snapshot in r["comments"].as_array().unwrap() {
                    let c = find_mut(v, "comments", snapshot["id"].as_str().unwrap())?;
                    c["status"] = json!("with_agent");
                    c["runId"] = json!(id);
                    event(c, "owner");
                }
                let r = find_mut(v, "runs", id)?;
                r["status"] = json!("starting");
                r["startedAt"] = json!(now());
                r["reportHash"] = json!(crate::engine::hash(token.as_bytes()));
                Ok(json!({"id":id,"status":"starting"}))
            })?;
            if run["existing"] != true {
                crate::runner::launch(self.clone(), id.to_string(), token);
            }
            return Ok(run);
        }
        if method == "POST" && path.ends_with("/cancel") && path.starts_with("/api/runs/") {
            let id = path
                .trim_start_matches("/api/runs/")
                .trim_end_matches("/cancel");
            return self.update(|v| {
                let r = find_mut(v, "runs", id)?;
                ensure!(active(r), "Run is already finished");
                ensure!(r["status"] != "interrupted", "Stop the original agent process on the host; recovery cannot safely signal a reused PID");
                r["cancelRequested"] = json!(true);
                Ok(json!({"ok":true}))
            });
        }
        if method == "GET" && path.starts_with("/api/runs/") {
            let v = self.read()?;
            let id = path.trim_start_matches("/api/runs/");
            let mut r = find(&v, "runs", id)?.clone();
            r.as_object_mut().unwrap().remove("reportHash");
            let log = self.state.join("runs").join(id).join("output.log");
            r["output"] = json!(String::from_utf8_lossy(
                &std::fs::read(log).unwrap_or_default()
            ));
            return Ok(r);
        }
        bail!("Unknown workflow route")
    }
    /// Freezes the exact brief, selected draft versions, rules and watched-branch commit.
    fn preview(&self, body: &Value) -> Result<Value> {
        let agent = text(body, "agent", 32)?;
        ensure!(["codex", "claude"].contains(&agent), "Unsupported agent");
        let ids = body["commentIds"]
            .as_array()
            .context("Missing commentIds")?;
        ensure!(!ids.is_empty() && ids.len() <= 100, "Select 1–100 drafts");
        let mut unique = std::collections::HashSet::new();
        for id in ids {
            ensure!(
                unique.insert(id.as_str().context("Invalid comment id")?),
                "Duplicate comment id"
            );
        }
        let brief = body["brief"].as_str().unwrap_or("");
        ensure!(brief.len() <= 20000, "Brief too large");
        let base = self.resolve(&self.watched)?;
        let rules = self
            .git(&["show", &format!("{base}:.strata.json")])
            .unwrap_or_else(|_| "No dependency rule configuration at this revision.".into());
        ensure!(rules.len() <= 65536, "Rule configuration is too large");
        self.update(|v| {
            let mut comments=vec![];
            for id in ids { let c = find(v,"comments",id.as_str().unwrap())?;
                ensure!(c["status"]=="draft","Only drafts can be sent");
                let mut c=c.clone();
                c.as_object_mut().unwrap().remove("history");
                comments.push(c);
            }
            let id = crate::random_token()[..16].to_string();
            let branch = format!("strata/run-{id}");
            let mut task=format!("# Task for {agent}, run {id}\nRepository: {}\nStart from {base} on {}. Work only on {branch} in the supplied worktree. Do not push or merge.\n\n## Brief\n{brief}\n\n## Review comments\n", self.repo.file_name().unwrap_or_default().to_string_lossy(), self.watched);
            for c in &comments { task.push_str(&format!("\n[{}] {} (left on {})\n{}\n",c["id"].as_str().unwrap(),c["anchor"],c["sha"].as_str().unwrap(),c["text"].as_str().unwrap()));
            }
            task.push_str(&format!("\n## Dependency rules at start\n{rules}\n\n## Reporting contract\nUse the strata MCP tools get_run, resolve_comment and flag_comment. Commit completed work before reporting. Every addressed commit must carry trailers Strata-Run: {id}, Strata-Comment: <comment id> (repeat for each comment), and Strata-Agent: {agent}. Call resolve_comment with comment_id, commit_sha, note and checks (commands, outcomes and limitations). If blocked, use flag_comment with comment_id and reason. Never claim owner verification. Do not alter Strata state or another worktree. Run appropriate checks and describe failures honestly.\n"));
            let r=json!({"id":id,"agent":agent,"branch":branch,"base":base,"watched":self.watched,"brief":brief,"comments":comments,"rules":rules,"task":task,"status":"preview","createdAt":now(),"results":[]});
            // Unsent previews have no audit value after a new preview and cannot be dispatched again.
            list(v,"runs").retain(|r| r["status"]!="preview");
            list(v,"runs").push(r.clone());
            Ok(r)
        })
    }
    /// Reads one internal run, including its credential hash for the reporting boundary.
    pub fn run(&self, id: &str) -> Result<Value> {
        Ok(find(&self.read()?, "runs", id)?.clone())
    }
    /// Persists runner progress without exposing reporting authority to the browser.
    pub fn patch_run(&self, id: &str, patch: Value) -> Result<Value> {
        self.update(|v| {
            let r = find_mut(v, "runs", id)?;
            for (k, val) in patch.as_object().unwrap() {
                r[k] = val.clone();
            }
            Ok(r.clone())
        })
    }
    /// Ends a run and marks every unanswered comment Unreported;
    /// reports are never auto-verified.
    pub fn finish(&self, id: &str, status: &str, message: &str, results: Value) -> Result<Value> {
        self.update(|v| {
            let r = find_mut(v, "runs", id)?;
            r["status"] = json!(status);
            r["message"] = json!(message);
            r["finishedAt"] = json!(now());
            r["results"] = results;
            r["reportHash"] = Value::Null;
            for c in list(v, "comments") {
                if c["runId"] == id && c["status"] == "with_agent" {
                    c["status"] = json!("unreported");
                    event(c, "runner");
                }
            }
            Ok(json!({"ok":true}))
        })
    }
    /// Accepts only reports for this active run and commits actually reachable from its branch.
    pub fn report(&self, id: &str, token: &str, tool: &str, args: &Value) -> Result<Value> {
        self.update(|v|{
            let run=find(v,"runs",id)?.clone();
            ensure!(active(&run) && crate::equal(run["reportHash"].as_str().unwrap_or(""),&crate::engine::hash(token.as_bytes())),"Run reporting credential rejected");
            if tool=="get_run" { let mut r=run;
                r.as_object_mut().unwrap().remove("reportHash");
                return Ok(r);
            }
            ensure!(["resolve_comment","flag_comment"].contains(&tool),"Unknown reporting tool");
            let cid=text(args,"comment_id",64)?;
            let c=find(v,"comments",cid)?;
            ensure!(c["runId"]==id && c["status"]=="with_agent","Comment is not awaiting this run");
            let report=if tool=="resolve_comment"{
                let sha=self.resolve(text(args,"commit_sha",256)?)?;
                ensure!(run["base"]!=sha,"Report must reference a new commit");
                self.git(&["merge-base","--is-ancestor",run["base"].as_str().unwrap(),&sha])?;
                self.git(&["merge-base","--is-ancestor",&sha,run["branch"].as_str().unwrap()])?;
                let trailers=self.git(&["show","-s","--format=%(trailers:only,unfold)",&sha])?;
                for required in [format!("Strata-Run: {id}"),format!("Strata-Comment: {cid}"),format!("Strata-Agent: {}",run["agent"].as_str().unwrap())] {ensure!(trailers.lines().any(|l|l==required),"Commit is missing required attribution trailers");
                }
                json!({"commit":sha,"note":text(args,"note",12000)?,"checks":text(args,"checks",20000)?,"at":now(),"agent":run["agent"]})
            }else{json!({"reason":text(args,"reason",12000)?,"at":now(),"agent":run["agent"]})};
            let c=find_mut(v,"comments",cid)?;
            c["report"]=report;
            c["status"]=json!(if tool=="resolve_comment"{"addressed"}else{"flagged"});
            event(c,"agent");
            Ok(c.clone())
        })
    }
}
/// Active and interrupted runs hold the repository slot until the supervisor closes them.
pub fn active(r: &Value) -> bool {
    ["starting", "running", "interrupted"].contains(&r["status"].as_str().unwrap_or(""))
}
