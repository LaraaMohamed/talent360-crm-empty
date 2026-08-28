"""
Offline tests for the multi-agent report generation system.

A fake LLM (no model download needed) returns a distinct, traceable label
for each prompt it receives so these tests can verify that: each agent's
output is genuinely built from the previous agent's output, all 5 agents
run in the right order, and empty input is rejected.

Run with:
    python test_orchestrator.py
"""
from agents import LLMBackend
from orchestrator import ReportOrchestrator


def fake_llm(prompt: str) -> str:
    """Returns a label naming which agent role produced it, echoing key input."""
    if "planning agent" in prompt.lower():
        return "PLAN: [step1, step2, step3]"
    if "research agent" in prompt.lower():
        assert "PLAN:" in prompt, "Research agent should receive the planner's output"
        return "RESEARCH_NOTES: based on PLAN"
    if "writer agent" in prompt.lower():
        assert "RESEARCH_NOTES:" in prompt, "Writer agent should receive the research notes"
        return "REPORT: built from RESEARCH_NOTES"
    if "summary agent" in prompt.lower():
        assert "REPORT:" in prompt, "Summary agent should receive the report"
        return "SUMMARY: of REPORT"
    if "evaluator agent" in prompt.lower():
        assert "REPORT:" in prompt, "Evaluator agent should receive the report"
        return "EVALUATION: of REPORT"
    raise AssertionError(f"Unexpected prompt with no recognizable agent role: {prompt[:80]}")


def test_agents_run_in_order_with_evaluator():
    orchestrator = ReportOrchestrator(use_evaluator=True, llm=LLMBackend(generator=fake_llm))
    result = orchestrator.generate_report("What are the benefits of remote work?")

    assert result["plan"] == "PLAN: [step1, step2, step3]"
    assert result["research_notes"] == "RESEARCH_NOTES: based on PLAN"
    assert result["report"] == "REPORT: built from RESEARCH_NOTES"
    assert result["summary"] == "SUMMARY: of REPORT"
    assert result["evaluation"] == "EVALUATION: of REPORT"
    print("PASS test_agents_run_in_order_with_evaluator")


def test_evaluator_is_optional():
    orchestrator = ReportOrchestrator(use_evaluator=False, llm=LLMBackend(generator=fake_llm))
    result = orchestrator.generate_report("What are the benefits of remote work?")
    assert "evaluation" not in result
    assert orchestrator.evaluator is None
    print("PASS test_evaluator_is_optional")


def test_empty_question_is_rejected():
    orchestrator = ReportOrchestrator(llm=LLMBackend(generator=fake_llm))
    try:
        orchestrator.generate_report("   ")
    except ValueError:
        print("PASS test_empty_question_is_rejected")
        return
    raise AssertionError("Expected ValueError for empty question")


def test_all_four_required_agents_exist():
    orchestrator = ReportOrchestrator(llm=LLMBackend(generator=fake_llm))
    assert orchestrator.planner is not None
    assert orchestrator.researcher is not None
    assert orchestrator.writer is not None
    assert orchestrator.summarizer is not None
    print("PASS test_all_four_required_agents_exist")


if __name__ == "__main__":
    test_agents_run_in_order_with_evaluator()
    test_evaluator_is_optional()
    test_empty_question_is_rejected()
    test_all_four_required_agents_exist()
    print("\nAll multi-agent orchestrator tests passed.")
