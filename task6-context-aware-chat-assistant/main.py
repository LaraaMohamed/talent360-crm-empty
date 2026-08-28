"""
Interactive chat loop demonstrating memory-aware conversation.

Run:
    python main.py

Try:
    You: My name is Ahmed.
    You: What is my name?
"""
from chat_assistant import ChatAssistant


def main():
    print("Loading model... (first run downloads the model, may take a moment)")
    assistant = ChatAssistant()
    print("Chat assistant ready. Type 'exit' to quit, 'clear' to reset memory.\n")

    while True:
        user_message = input("You: ").strip()
        if user_message.lower() in ("exit", "quit"):
            break
        if user_message.lower() == "clear":
            assistant.memory.clear()
            print("Memory cleared.\n")
            continue
        if not user_message:
            continue

        response = assistant.ask(user_message)
        print(f"Assistant: {response}\n")


if __name__ == "__main__":
    main()
