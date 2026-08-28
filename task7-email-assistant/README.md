# Task 7 — Automated Generative AI Email Assistant with API Functions

Simulates a customer-support workflow: a customer message comes in, an LLM
drafts a professional reply, and the system automatically formats, saves,
and "sends" the email using API-like functions, with basic error handling.

## Architecture
- `email_generator.py` — `EmailGenerator` calls a Hugging Face `text2text-generation` model (`google/flan-t5-base`) to turn a raw customer message into a professional reply.
- `api_functions.py` — simulated backend API functions:
  - `format_email()` — builds a structured email dict (recipient, subject, body, timestamp).
  - `save_email()` — persists the email to `data/sent_emails.json`.
  - `send_email()` — simulates sending (prints a send confirmation; swap in a real SMTP/API call to go live).
  - `log_action()` — appends an audit trail to `data/email_log.txt`.
- `pipeline.py` — `process_customer_message()` wires the steps together and handles errors at each stage (empty input, failed save, failed send).
- `main.py` — interactive CLI that simulates incoming customer messages.

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
Customer message: My order hasn't arrived yet and it's been 2 weeks.
Customer email (optional, press enter to skip): jane@example.com

Email processed successfully:
  To: jane@example.com
  Subject: Re: Your inquiry
  Body: Dear Jane, thank you for reaching out ...
```

## Error handling
- Empty customer message → generation is rejected with a clear error, nothing is saved or sent.
- Empty generated body → formatting step rejects it before save/send.
- Save/send failures are caught, logged to `data/email_log.txt`, and reported back to the caller instead of crashing the pipeline.
