# Task 6 — Context-Aware Chat Assistant with Memory

A chat assistant that remembers earlier turns of the conversation and
injects them as context into every new prompt, so it can answer questions
like "What is my name?" after the user previously said "My name is Ahmed."

## How it works
- `memory.py` — `ConversationMemory` stores every user/assistant turn and renders it as a plain-text transcript.
- `chat_assistant.py` — `ChatAssistant` loads a Hugging Face `text2text-generation` model (`google/flan-t5-base`), builds a prompt from `[system instructions] + [full history] + [new question]`, sends it to the model, then appends the exchange back into memory.
- `main.py` — runs a continuous terminal chat loop.

## Setup
```bash
pip install -r requirements.txt
```

## Run
```bash
python main.py
```

## Example
```
You: My name is Ahmed.
Assistant: Nice to meet you, Ahmed!

You: What is my name?
Assistant: Your name is Ahmed.
```

## Notes
- Swap the model in `ChatAssistant(model_name=...)` for a larger/better instruction-tuned model if you have the compute, or replace `pipeline(...)` with an API-based chat model (OpenAI/Anthropic) — the memory logic stays the same.
- `memory.max_turns` caps how many turns are kept in context to control prompt length.
