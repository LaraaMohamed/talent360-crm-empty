"""
Defines the individual agents that collaborate to produce a report.

Each agent has a single responsibility and communicates through a shared
LLM instance and a plain-text prompt built from the previous agents' output.
"""
class LLMBackend:
    """Shared text-generation backend used by all agents.

    Wraps a generator callable(prompt: str) -> str. Defaults to a local
    Hugging Face model, loaded lazily so the agent classes can be
    unit-tested with a fake callable without downloading anything.
    """

    def __init__(self, generator=None, model_name: str = "google/flan-t5-base", max_new_tokens: int = 256):
        self.generator = generator or self._build_default_generator(model_name, max_new_tokens)

    @staticmethod
    def _build_default_generator(model_name: str, max_new_tokens: int):
        from transformers import pipeline

        pipe = pipeline("text2text-generation", model=model_name, max_new_tokens=max_new_tokens)
        return lambda prompt: pipe(prompt)[0]["generated_text"].strip()

    def run(self, prompt: str) -> str:
        return self.generator(prompt)


class PlannerAgent:
    """Breaks the user's question down into a short research plan."""

    def __init__(self, llm: LLMBackend):
        self.llm = llm

    def run(self, question: str) -> str:
        prompt = (
            "You are a planning agent. Break the following question into a "
            "numbered list of 3-4 key research points to investigate.\n\n"
            f"Question: {question}\n\nPlan:"
        )
        return self.llm.run(prompt)


class ResearchAgent:
    """Gathers information/notes for each point in the plan.

    This uses the LLM's own knowledge to produce research notes. In a
    production system, swap `self.llm.run(prompt)` for calls to a real
    search API (e.g. web search, a vector database, or internal docs).
    """

    def __init__(self, llm: LLMBackend):
        self.llm = llm

    def run(self, question: str, plan: str) -> str:
        prompt = (
            "You are a research agent. Given the question and the research "
            "plan below, provide concise factual notes covering each point.\n\n"
            f"Question: {question}\n\nPlan:\n{plan}\n\nResearch notes:"
        )
        return self.llm.run(prompt)


class WriterAgent:
    """Turns research notes into a structured report draft."""

    def __init__(self, llm: LLMBackend):
        self.llm = llm

    def run(self, question: str, research_notes: str) -> str:
        prompt = (
            "You are a writer agent. Using the research notes below, write a "
            "well-structured report with an introduction, body, and conclusion "
            "that answers the original question.\n\n"
            f"Question: {question}\n\nResearch notes:\n{research_notes}\n\nReport:"
        )
        return self.llm.run(prompt)


class SummaryAgent:
    """Produces a short executive summary of the full report."""

    def __init__(self, llm: LLMBackend):
        self.llm = llm

    def run(self, report: str) -> str:
        prompt = (
            "You are a summary agent. Summarize the following report in 2-3 "
            "sentences for an executive audience.\n\n"
            f"Report:\n{report}\n\nSummary:"
        )
        return self.llm.run(prompt)


class EvaluatorAgent:
    """(Optional) Reviews the report and flags gaps or improvements."""

    def __init__(self, llm: LLMBackend):
        self.llm = llm

    def run(self, question: str, report: str) -> str:
        prompt = (
            "You are an evaluator agent. Review the report below for how well "
            "it answers the original question. List any gaps or suggested "
            "improvements in 2-3 bullet points.\n\n"
            f"Question: {question}\n\nReport:\n{report}\n\nEvaluation:"
        )
        return self.llm.run(prompt)
