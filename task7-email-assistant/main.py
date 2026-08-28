"""
CLI entry point: simulates a customer message coming in and being handled
end to end by the automated email pipeline.

Run:
    python main.py
"""
from email_generator import EmailGenerator
from pipeline import process_customer_message


def main():
    print("Loading model...")
    generator = EmailGenerator()
    print("Email assistant ready. Type 'exit' to quit.\n")

    while True:
        message = input("Customer message: ").strip()
        if message.lower() in ("exit", "quit"):
            break

        recipient = input("Customer email (optional, press enter to skip): ").strip()
        result = process_customer_message(generator, message, recipient)

        if result["status"] == "success":
            email = result["email"]
            print("\nEmail processed successfully:")
            print(f"  To: {email['recipient']}")
            print(f"  Subject: {email['subject']}")
            print(f"  Body: {email['body']}\n")
        else:
            print(f"\nFailed to process message: {'; '.join(result['errors'])}\n")


if __name__ == "__main__":
    main()
