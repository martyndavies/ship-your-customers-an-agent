"""
An Acme developer asks Hookline's support agent a question over Blocks.

This is the scripted version of what you can also do from Claude Code with
the Blocks MCP server. It uses Acme's BLOCKS_API_KEY from .env.

Usage:  uv run ask_hookline.py "Why are my Hookline webhooks failing?"
"""

import base64
import os
import sys
import threading

from blocks_network import SendMessageRequestPart, create_task_client

AGENT = os.environ.get("HOOKLINE_SUPPORT_AGENT", "hookline_support")
QUESTION = sys.argv[1] if len(sys.argv) > 1 else "Why are my Hookline webhooks failing?"


def main() -> None:
    client = create_task_client()
    session = client.send_message(
        agent_name=AGENT,
        request_parts=[SendMessageRequestPart(part_id="request", text=QUESTION)],
    )
    print(f"Asked {AGENT}: {QUESTION}\n")

    done = threading.Event()

    def on_progress(event):
        print("  ...", event.get("message") or event.get("progress") or "")

    def on_artifact(event):
        ref = event.artifact_ref
        if ref is None:
            return
        name = getattr(ref, "file_name", None) or "artifact"
        if name.endswith(".json"):
            # Keep the screen readable: the evidence bundle is summarized, the diagnosis is shown in full.
            print(f"  ... received {name}")
            return
        data = base64.b64decode(ref.data).decode() if ref.kind == "inline" and ref.data else session.download_artifact(ref).data.decode()
        print(f"\n{data}\n")

    def on_terminal(event):
        print(f"[done] {getattr(event, 'state', '')}")
        done.set()

    session.on_progress(on_progress)
    session.on_artifact(on_artifact)
    session.on_terminal(on_terminal)

    done.wait(timeout=120)
    session.close()
    client.destroy()


if __name__ == "__main__":
    main()
