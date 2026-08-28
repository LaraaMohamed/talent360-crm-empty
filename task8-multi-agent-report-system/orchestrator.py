"""
Coordinates the multi-agent pipeline step by step, passing each agent's
output as input to the next.
"""
from agents import (
    LLMBackend,
    PlannerAgent,
    ResearchAgent,
    WriterAgent,
    SummaryAgent,
    EvaluatorAgent,
)


class ReportOrchestrator:
    def __init__(self, use_evaluator: bool = True, llm: LLMBackend = None):
        self.llm = llm or LLMBackend()
        self.planner = PlannerAgent(self.llm)
        self.researcher = ResearchAgent(self.llm)
        self.writer = WriterAgent(self.llm)
        self.summarizer = SummaryAgent(self.llm)
        self.evaluator = EvaluatorAgent(self.llm) if use_evaluator else None

    def generate_report(self, question: str) -> dict:
        if not question or not question.strip():
            raise ValueError("Question cannot be empty.")

        plan = self.planner.run(question)
        research_notes = self.researcher.run(question, plan)
        report = self.writer.run(question, research_notes)
        summary = self.summarizer.run(report)

        result = {
            "question": question,
            "plan": plan,
            "research_notes": research_notes,
            "report": report,
            "summary": summary,
        }

        if self.evaluator:
            result["evaluation"] = self.evaluator.run(question, report)

        return result
