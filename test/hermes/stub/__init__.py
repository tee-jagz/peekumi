"""Record the real Hermes hook payloads without analysis or external calls."""

events = []


def register(ctx):
    """Register three public hooks. Keep their payloads in this probe process only."""
    def before(**payload):
        events.append(("pre_llm_call", payload))
        return {"context": "Peekumi baseline probe"}

    def verify(**payload):
        events.append(("pre_verify", payload))
        return {"action": "continue", "message": "Probe finding still open"}

    def after(**payload):
        events.append(("post_llm_call", payload))

    ctx.register_hook("pre_llm_call", before)
    ctx.register_hook("pre_verify", verify)
    ctx.register_hook("post_llm_call", after)
