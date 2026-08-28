# Task 7 — Automated Generative AI Email Assistant with API Functions

Simulates a customer-support workflow: a customer message comes in, an LLM
drafts a professional reply, and the system automatically formats, saves,
and "sends" the email using API-like functions, with error handling for
empty input and failed save/send.

## Objectives checklist
- [x] Load/call an LLM (`email_generator.py`)
- [x] Generate structured responses in email format (`api_functions.py:format_email`)
- [x] API-like functions: save, send, log (`api_functions.py`)
- [x] Automate the full pipeline end to end (`pipeline.py:process_customer_message`)
- [x] Handle simple errors: empty input, failed save (tested explicitly)
- [x] Automated tests proving the success path and both failure paths

## Architecture
- `email_generator.py` — `EmailGenerator` calls a generator (defaults to a local Hugging Face `text2text-generation` model, `google/flan-t5-base`) to turn a raw customer message into a professional reply. Rejects empty input with `ValueError`.
- `api_functions.py` — simulated backend API functions:
  - `format_email()` — builds a structured email dict (recipient, subject, body, timestamp); rejects an empty body.
  - `save_email()` — persists the email to `data/sent_emails.json` (path injectable, returns `False` instead of raising on `OSError`).
  - `send_email()` — simulates sending (prints a send confirmation; swap in a real SMTP/API call to go live).
  - `log_action()` — appends an audit trail to `data/email_log.txt`.
- `pipeline.py` — `process_customer_message()` wires the steps together (generate → format → save → send → log) and short-circuits with a reported error at whichever stage fails.
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

## Automated tests (run offline, no model download required)
`test_email_pipeline.py` injects a fake generator to test the full pipeline
without downloading a model, and explicitly exercises both required error
scenarios: empty customer input, and a failed save (by pointing the save
path at a location that cannot be created).

```bash
python test_email_pipeline.py
```

Verified output (see `test_output.txt`):
```
PASS test_format_email_rejects_empty_body
PASS test_send_email_rejects_missing_body
[SIMULATED SEND] To: jane@example.com | Subject: Re: Your inquiry
PASS test_pipeline_success_path
PASS test_pipeline_handles_empty_input
PASS test_pipeline_handles_failed_save

All email assistant tests passed.
```

## Error handling
- Empty customer message → generation is rejected with a clear error, nothing is saved or sent, and `GENERATE_FAILED` is logged.
- Empty generated body → formatting step rejects it before save/send.
- Save/send failures are caught, logged (`SAVE_FAILED`/`SEND_FAILED`) to `data/email_log.txt`, and reported back to the caller instead of crashing the pipeline.
