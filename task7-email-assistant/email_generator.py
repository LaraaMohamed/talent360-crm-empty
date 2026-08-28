"""
Generates a professional email reply from a customer message using an LLM.
"""
PROMPT_TEMPLATE = (
    "You are a professional customer support agent. Write a polite, concise "
    "email reply to the following customer message. Include a greeting, an "
    "answer to their concern, and a professional sign-off.\n\n"
    "Customer message: {message}\n\nReply:"
)


def build_default_generator(model_name: str = "google/flan-t5-base", max_new_tokens: int = 200):
    """Returns a callable(prompt: str) -> str backed by a local Hugging Face model."""
    from transformers import pipeline

    pipe = pipeline("text2text-generation", model=model_name, max_new_tokens=max_new_tokens)
    return lambda prompt: pipe(prompt)[0]["generated_text"].strip()


class EmailGenerator:
    """Wraps a generator callable to turn a customer message into a reply.

    `generator` defaults to a local Hugging Face model but can be any
    callable(prompt: str) -> str, which makes this class testable offline
    without downloading a model (see test_email_pipeline.py).
    """

    def __init__(self, generator=None):
        self.generator = generator or build_default_generator()

    def generate_reply(self, customer_message: str) -> str:
        if not customer_message or not customer_message.strip():
            raise ValueError("Customer message cannot be empty.")
        prompt = PROMPT_TEMPLATE.format(message=customer_message.strip())
        return self.generator(prompt)
