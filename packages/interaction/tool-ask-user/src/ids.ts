/**
 * Deterministic question-id normalization shared by the two
 * `ask_user_question` tool definitions.
 *
 * A question `id` anchors the answer batch; it carries no model-facing meaning
 * beyond that echo. Models routinely omit it, and a strict required-field
 * rejection then fails the whole call for a value that is purely derivable.
 * Omitted ids are therefore filled positionally (`q1`, `q2`, …), with a `_k`
 * suffix when the candidate collides with an id the model did supply.
 *
 * The Genshu host parses the raw `tool/call` arguments before the tool runs
 * (`parseDshAskQuestions`), so it implements the same rule — keep both sides in
 * sync (Genshu host repo: docs/kernel/K5).
 */

/** Whether a model-supplied id counts as present (non-empty, non-blank). */
function isPresent(id: string | undefined): id is string {
  return typeof id === 'string' && id.trim() !== ''
}

/**
 * Fill omitted question ids with a stable, collision-free positional scheme.
 * @param questions - Model-supplied questions in tool-schema order.
 * @returns The same questions with a concrete id on every position, in order.
 */
export function fillQuestionIds<T extends { readonly id?: string }>(
  questions: readonly T[],
): (T & { readonly id: string })[] {
  const taken = new Set<string>()
  for (const question of questions) {
    if (isPresent(question.id)) taken.add(question.id)
  }
  return questions.map((question, index) => {
    if (isPresent(question.id)) return { ...question, id: question.id }
    const base = `q${index + 1}`
    let candidate = base
    let suffix = 2
    while (taken.has(candidate)) candidate = `${base}_${suffix++}`
    taken.add(candidate)
    return { ...question, id: candidate }
  })
}
