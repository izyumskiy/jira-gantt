// Объединение read-only источников в единый вход анализа.

export function composeProjectSource({ jira, businessRequirements = null, systemAnalysis = null, repositoryAnalysis = null }) {
  if (!jira) throw new Error("Укажите проект или эпик Jira");
  const documents = {
    businessRequirements: {
      kind: "businessRequirements",
      label: "Бизнес-требования",
      provided: Boolean(businessRequirements),
      title: businessRequirements?.title || "",
      url: businessRequirements?.url || ""
    },
    systemAnalysis: {
      kind: "systemAnalysis",
      label: "Системный анализ",
      provided: Boolean(systemAnalysis),
      title: systemAnalysis?.title || "",
      url: systemAnalysis?.url || ""
    }
  };
  const sections = [
    jira.description || "",
    businessRequirements ? `Confluence — бизнес-требования: ${businessRequirements.title}\n${businessRequirements.description || ""}` : "",
    systemAnalysis ? `Confluence — системный анализ: ${systemAnalysis.title}\n${systemAnalysis.description || ""}` : ""
  ].filter(Boolean);
  return {
    ...jira,
    description: sections.join("\n\n"),
    comments: [
      ...(jira.comments || []),
      ...(businessRequirements?.comments || []),
      ...(systemAnalysis?.comments || [])
    ],
    documents,
    repositoryAnalysis
  };
}
