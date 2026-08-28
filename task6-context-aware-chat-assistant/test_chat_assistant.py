"""
Offline tests for the context-aware chat assistant.

A fake generator (no model download needed) parses the prompt it receives,
so these tests prove that conversation history is actually being built and
injected into each new prompt -- not just that some text comes back.

Run with:
    python test_chat_assistant.py
"""
import re

from chat_assistant import ChatAssistant
from memory import ConversationMemory


def fake_llm(prompt: str) -> str:
    """A tiny rule-based 'model' that only knows what's in the prompt it receives."""
    if "what is my name" in prompt.lower():
        match = re.search(r"my name is (\w+)", prompt, re.IGNORECASE)
        if match:
            return f"Your name is {match.group(1)}."
        return "I don't know your name yet."
    match = re.search(r"my name is (\w+)", prompt, re.IGNORECASE)
    if match and "User:" in prompt.split("\n\n")[-1]:
        return f"Nice to meet you, {match.group(1)}!"
    return "Okay."


def test_memory_stores_turns():
    memory = ConversationMemory()
    memory.add_user_message("Hello")
    memory.add_ai_message("Hi there!")
    context = memory.build_context()
    assert "User: Hello" in context
    assert "Assistant: Hi there!" in context
    print("PASS test_memory_stores_turns")


def test_memory_trims_to_max_turns():
    memory = ConversationMemory(max_turns=2)
    for i in range(5):
        memory.add_user_message(f"msg {i}")
        memory.add_ai_message(f"reply {i}")
    assert len(memory.history) == 4  # 2 turns * 2 messages
    print("PASS test_memory_trims_to_max_turns")


def test_assistant_remembers_name_across_turns():
    assistant = ChatAssistant(generator=fake_llm)

    first_reply = assistant.ask("My name is Ahmed.")
    assert "Ahmed" in first_reply

    second_reply = assistant.ask("What is my name?")
    assert "Ahmed" in second_reply, f"Expected the assistant to recall the name, got: {second_reply!r}"
    print("PASS test_assistant_remembers_name_across_turns")


def test_prompt_without_history_has_no_prior_context():
    assistant = ChatAssistant(generator=fake_llm)
    prompt = assistant.build_prompt("What is my name?")
    assert "Conversation so far" not in prompt
    print("PASS test_prompt_without_history_has_no_prior_context")


def test_prompt_includes_full_history():
    assistant = ChatAssistant(generator=fake_llm)
    assistant.ask("My name is Sara.")
    prompt = assistant.build_prompt("What is my name?")
    assert "Conversation so far" in prompt
    assert "Sara" in prompt
    print("PASS test_prompt_includes_full_history")


def test_clear_memory_forgets_context():
    assistant = ChatAssistant(generator=fake_llm)
    assistant.ask("My name is Layla.")
    assistant.memory.clear()
    reply = assistant.ask("What is my name?")
    assert "don't know" in reply.lower()
    print("PASS test_clear_memory_forgets_context")


if __name__ == "__main__":
    test_memory_stores_turns()
    test_memory_trims_to_max_turns()
    test_assistant_remembers_name_across_turns()
    test_prompt_without_history_has_no_prior_context()
    test_prompt_includes_full_history()
    test_clear_memory_forgets_context()
    print("\nAll chat assistant tests passed.")
