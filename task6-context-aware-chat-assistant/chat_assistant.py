"""
Context-aware chat assistant built on a Hugging Face text-generation model.

Each new prompt is built from the full conversation history plus the new
user question, so the model can refer back to earlier turns (e.g. remember
the user's name).
"""
from transformers import pipeline

from memory import ConversationMemory

SYSTEM_PROMPT = (
    "You are a helpful assistant. Use the conversation history below to "
    "answer the user's latest question, remembering any facts they told you."
)


class ChatAssistant:
    def __init__(self, model_name: str = "google/flan-t5-base", max_new_tokens: int = 128):
        self.generator = pipeline("text2text-generation", model=model_name, max_new_tokens=max_new_tokens)
        self.memory = ConversationMemory()

    def _build_prompt(self, user_message: str) -> str:
        context = self.memory.build_context()
        parts = [SYSTEM_PROMPT]
        if context:
            parts.append("Conversation so far:\n" + context)
        parts.append(f"User: {user_message}\nAssistant:")
        return "\n\n".join(parts)

    def ask(self, user_message: str) -> str:
        prompt = self._build_prompt(user_message)
        response = self.generator(prompt)[0]["generated_text"].strip()
        self.memory.add_user_message(user_message)
        self.memory.add_ai_message(response)
        return response
