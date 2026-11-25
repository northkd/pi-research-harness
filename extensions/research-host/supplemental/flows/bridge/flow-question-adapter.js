class FlowQuestionAdapter {
  name = "flow-question";
  priority = 100;
  onRequest(prompt) {
    const flowId = prompt.metadata?.flowId;
    if (typeof flowId !== "string" || flowId.length === 0) return null;
    const stepId = typeof prompt.metadata?.stepId === "string" ? prompt.metadata.stepId : "";
    return {
      component: {
        type: "flow-question",
        props: {
          flowId,
          stepId,
          question: prompt.question,
          type: prompt.type,
          options: prompt.options,
          defaultValue: prompt.defaultValue
        }
      },
      placement: "widget-bar"
    };
  }
  onResponse(_response) {
  }
  onCancel(_id) {
  }
}
export {
  FlowQuestionAdapter
};
