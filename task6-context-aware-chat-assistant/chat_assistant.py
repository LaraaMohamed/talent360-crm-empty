"""
Context-aware chat assistant built on a language model.

Each new prompt is built from the full conversation history plus the new
user question, so the model can refer back to earlier turns (e.g. remember
the user's name).
"""
from memory import ConversationMemory

SYSTEM_PROMPT = (
    "You are a helpful assistant. Use the conversation history below to "
    "answer the user's latest question, remembering any facts they told you."
)


def build_default_generator(model_name: str = "google/flan-t5-base", max_new_tokens: int = 128):
    """Returns a callable(prompt: str) -> str backed by a local Hugging Face model."""
    from transformers import pipeline

    pipe = pipeline("text2text-generation", model=model_name, max_new_tokens=max_new_tokens)
    return lambda prompt: pipe(prompt)[0]["generated_text"].strip()


class ChatAssistant:
    """Wraps a generator callable with conversation memory.

    `generator` defaults to a local Hugging Face model but can be any
    callable(prompt: str) -> str, which makes the memory/context logic
    testable offline without downloading a model (see test_chat_assistant.py).
    """

    def __init__(self, generator=None):
        self.generator = generator or build_default_generator()
        self.memory = ConversationMemory()

    def build_prompt(self, user_message: str) -> str:
        context = self.memory.build_context()
        parts = [SYSTEM_PROMPT]
        if context:
            parts.append("Conversation so far:\n" + context)
        parts.append(f"User: {user_message}\nAssistant:")
        return "\n\n".join(parts)

    def ask(self, user_message: str) -> str:
        prompt = self.build_prompt(user_message)
        response = self.generator(prompt)
        self.memory.add_user_message(user_message)
        self.memory.add_ai_message(response)
        return response
