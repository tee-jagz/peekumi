"""Hermes lifecycle policy. Peekumi owns findings, scores and outcome decisions."""
import hashlib
import json
import os
from pathlib import Path
import threading

from .peekumi_client import Unavailable


def nudge_limit(config):
    """Match Hermes' cap default for absent, null or invalid agent settings."""
    agent = config.get("agent") if isinstance(config, dict) else None
    value = agent.get("max_verify_nudges") if isinstance(agent, dict) else None
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 3


class Store:
    """Save latest session evidence atomically in private plugin state, without secrets."""
    def __init__(self, root):
        self.path = Path(root) / "sessions"
        self.lock = threading.RLock()

    def read(self, key):
        try:
            return json.loads((self.path / (key + ".json")).read_text())
        except FileNotFoundError:
            return None

    def update(self, key, value):
        with self.lock:
            self.path.mkdir(parents=True, exist_ok=True, mode=0o700)
            destination = self.path / (key + ".json")
            pending = destination.with_suffix(f".{os.getpid()}.pending")
            fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as out:
                json.dump(value, out)
            pending.replace(destination)


class Gate:
    """Bind a baseline before edits and preserve API outcomes after the turn ends."""
    def __init__(self, client, store, profile, threshold=30, mode="nudge"):
        self.client, self.store, self.profile = client, store, profile
        self.threshold, self.mode = threshold, mode

    def key(self, session):
        return hashlib.sha256(json.dumps([self.profile, session]).encode()).hexdigest()

    def current(self, session):
        return self.store.read(self.key(session))

    def save(self, session, state):
        self.store.update(self.key(session), state)

    @staticmethod
    def unavailable(reason):
        return {"status": "unavailable", "limits": [str(reason)], "findings": []}

    def before(self, session, turn):
        """Capture once per turn. A failed capture never becomes a baseline after editing."""
        with self.store.lock:
            state = self.current(session)
            if state and state["turn"] == turn:
                return state
            state = {"turn": turn, "session": session, "profile": self.profile, "exhaust_pending": False}
            try:
                state["baseline"] = self.client().call("baseline", {"profile": self.profile, "session": session, "turn": turn})
                state["result"] = state["baseline"]
            except Unavailable as exc:
                state["result"] = self.unavailable(exc)
            self.save(session, state)
            return state

    def refresh(self, session):
        """Refresh evidence without moving the baseline. Never manufacture passed."""
        state = self.current(session)
        if not state or not state.get("baseline", {}).get("id"):
            return self.unavailable("No baseline was captured before edits")
        if state.get("pending_measurement"):
            return self.unavailable("Measurement evidence is waiting for submission; call peekumi_measure to resume")
        try:
            result = self.client().call("impact", baseline=state["baseline"]["id"], threshold=self.threshold)
            if result.get("status") not in {"passed", "findings", "exception", "incomplete", "unavailable"}:
                raise Unavailable("Peekumi returned an unknown outcome")
        except Unavailable as exc:
            result = self.unavailable(exc)
        state["result"] = result
        self.save(session, state)
        return result

    def verify(self, session, attempt, cap):
        """Nudge only for API findings. Remember the last allowed nudge for finalization."""
        result = self.refresh(session)
        if self.mode != "nudge" or result["status"] != "findings" or attempt >= cap:
            return None
        state = self.current(session)
        state["exhaust_pending"] = attempt >= cap - 1
        self.save(session, state)
        details = [finding.get("message", finding.get("id", "Open finding")) for finding in result.get("findings", []) if not finding.get("exception")]
        if not details:
            details = ["Additional findings exceed the detailed response limit. Read the rule-check limits before finishing."]
        return {"action": "continue", "message": "Peekumi findings:\n" + "\n".join(details) + "\nFix these findings and call peekumi_measure. If a finding must stay, record its ID and reason with peekumi_impact."}

    def after(self, session, turn):
        """Observe final evidence, including shell edits and completion after the nudge cap."""
        state = self.current(session)
        if not state or state["turn"] != turn:
            result = self.unavailable("Turn has no matching pre-edit baseline")
            if state:
                state["result"] = result
                self.save(session,state)
            return result
        result = self.refresh(session)
        state = self.current(session)
        if result["status"] == "findings" and state["exhaust_pending"]:
            result = {**result, "status": "exhausted", "stopped": "the agent stopped"}
        state["result"] = result
        self.save(session, state)
        return result

    def end(self, session):
        """Release session pins. An outage leaves the server's 24-hour expiry in control."""
        try:
            return self.client().call("baseline", {"action": "release", "profile": self.profile, "session": session})
        except Unavailable:
            return None
