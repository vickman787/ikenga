import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import StepCard from "./StepCard";

describe("StepCard — Who did what", () => {
  it("shows the agent, what they did, and the verdict — but never the model, tokens or cost", () => {
    const html = renderToStaticMarkup(
      <StepCard
        step={{
          agent: "Auditor",
          what: "Read the work on a different model",
          detail: "PASS — the prices match the brief.",
          model: "gpt-4o-mini",
          tokens: 1946,
          costUsd: 0.0005,
        }}
      />,
    );
    expect(html).toContain("Auditor");
    expect(html).toContain("Read the work on a different model");
    expect(html).toContain("PASS");
    // The per-step model/cost line is hidden by the customer's call:
    // no model name, no token count, no cost anywhere in the markup.
    expect(html).not.toContain("gpt-4o-mini");
    expect(html).not.toContain("gpt-4o");
    expect(html).not.toContain("1,946");
    expect(html).not.toContain("1946");
    expect(html).not.toContain("0.0005");
    expect(html).not.toContain("tokens");
  });

  it("renders a step with no detail and no model data", () => {
    const html = renderToStaticMarkup(<StepCard step={{ agent: "Designer", what: "Built the one-page website" }} />);
    expect(html).toContain("Designer");
    expect(html).toContain("Built the one-page website");
  });
});
