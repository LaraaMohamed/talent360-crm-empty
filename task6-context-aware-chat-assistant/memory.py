"""
Simple conversation memory store.

Keeps a running list of (role, message) turns and can render them as a
single context string to prepend to each new prompt sent to the model.
"""


class ConversationMemory:
    def __init__(self, max_turns: int = 20):
        self.max_turns = max_turns
        self.history = []  # list of {"role": "user"|"assistant", "content": str}

    def add_user_message(self, message: str):
        self.history.append({"role": "user", "content": message})
        self._trim()

    def add_ai_message(self, message: str):
        self.history.append({"role": "assistant", "content": message})
        self._trim()

    def _trim(self):
        if len(self.history) > self.max_turns * 2:
            self.history = self.history[-self.max_turns * 2 :]

    def build_context(self) -> str:
        lines = []
        for turn in self.history:
            speaker = "User" if turn["role"] == "user" else "Assistant"
            lines.append(f"{speaker}: {turn['content']}")
        return "\n".join(lines)

    def clear(self):
        self.history = []
