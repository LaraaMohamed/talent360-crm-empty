"""
Generates a professional email reply from a customer message using an LLM.
"""
from transformers import pipeline

PROMPT_TEMPLATE = (
    "You are a professional customer support agent. Write a polite, concise "
    "email reply to the following customer message. Include a greeting, an "
    "answer to their concern, and a professional sign-off.\n\n"
    "Customer message: {message}\n\nReply:"
)


class EmailGenerator:
    def __init__(self, model_name: str = "google/flan-t5-base", max_new_tokens: int = 200):
        self.generator = pipeline("text2text-generation", model=model_name, max_new_tokens=max_new_tokens)

    def generate_reply(self, customer_message: str) -> str:
        if not customer_message or not customer_message.strip():
            raise ValueError("Customer message cannot be empty.")
        prompt = PROMPT_TEMPLATE.format(message=customer_message.strip())
        result = self.generator(prompt)[0]["generated_text"].strip()
        return result
