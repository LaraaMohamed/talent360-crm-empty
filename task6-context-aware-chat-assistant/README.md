# Task 6 — Context-Aware Chat Assistant with Memory

A chat assistant that remembers earlier turns of the conversation and
injects them as context into every new prompt, so it can answer questions
like "What is my name?" after the user previously said "My name is Ahmed."

## Objectives checklist
- [x] Load an LLM (Hugging Face `transformers` `text2text-generation` pipeline)
- [x] Build a chat loop where the user can ask multiple questions (`main.py`)
- [x] Store conversation history (`memory.py:ConversationMemory`)
- [x] Inject the previous conversation as context in each new prompt (`chat_assistant.py:ChatAssistant.build_prompt`)
- [x] Run a continuous chat loop and demonstrate memory (name recall)
- [x] Automated tests proving memory actually affects responses

## How it works
- `memory.py` — `ConversationMemory` stores every user/assistant turn and renders it as a plain-text transcript, trimmed to the last `max_turns` turns.
- `chat_assistant.py` — `ChatAssistant` builds a prompt from `[system instructions] + [full history] + [new question]`, sends it to a generator, then appends the exchange back into memory. The generator defaults to a local Hugging Face model (`google/flan-t5-base`) but is injectable, so the memory logic can be tested without downloading a model.
- `main.py` — runs a continuous terminal chat loop (`clear` resets memory, `exit` quits).

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

## Automated tests (run offline, no model download required)
`test_chat_assistant.py` uses a small rule-based fake generator that can
only answer from the prompt text it receives, which proves the conversation
history is genuinely being built and passed to the model on each turn —
not just that a model returns some plausible-looking text.

```bash
python test_chat_assistant.py
```

Verified output (see `test_output.txt`):
```
PASS test_memory_stores_turns
PASS test_memory_trims_to_max_turns
PASS test_assistant_remembers_name_across_turns
PASS test_prompt_without_history_has_no_prior_context
PASS test_prompt_includes_full_history
PASS test_clear_memory_forgets_context

All chat assistant tests passed.
```

## Notes
- Swap the model in `chat_assistant.py:build_default_generator()` for a larger/better instruction-tuned model, or pass any `generator=callable(prompt) -> str` (e.g. an API-based chat model) to `ChatAssistant()` — the memory logic stays the same.
- `ConversationMemory(max_turns=...)` caps how many turns are kept in context to control prompt length.
