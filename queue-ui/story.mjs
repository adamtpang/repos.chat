// Source-based excerpts and suggestions, not generated claims of completed work.
export function repoName(card) { return card.checkout?.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || card.title || 'Your repo'; }
export function excerpt(text, limit = 200) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(^|\n)\s*[#>*-]+\s*/g, '$1').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : clean.slice(0, limit).replace(/\s+\S*$/, '') + '…';
}
export function petVariant(card) { return [...repoName(card)].reduce((n,c) => n + c.codePointAt(0), 0) % 4; }
export function chapterFor(card) {
  try {
    const chapter=card.adventure || JSON.parse(card.result);
    if(typeof chapter.recap!=='string' || !Array.isArray(chapter.paths) || chapter.paths.length!==3)return null;
    if(chapter.paths.some(p=>!['title','description','prompt'].every(k=>typeof p[k]==='string' && p[k].trim() && p[k].length<=20000)))return null;
    return chapter;
  }catch{return null;}
}
export function statusLabel(card) {
  if(card.delivery && card.request?.desktopReceipt?.confirmed)return 'Prompt submitted';
  if (card.delivery) return card.request?.status === 'uncertain' ? 'Checking delivery' : card.request?.status === 'approved' ? 'Ready for relay' : 'Away working';
  if (card.error || card.turnStatus === 'failed') return 'Needs a hand';
  if (card.state === 'running') return 'Away working';
  if (card.returned) return 'Back with news';
  return ({ parked: 'Resting', done: 'Chapter complete', 'external blocker': 'Waiting on access', 'needs Adam': 'Your turn', ready: 'Your turn' })[card.triage?.disposition] || 'Checking in';
}
export function pathsFor(card) {
  const chapter=chapterFor(card);if(chapter && (card.adventure || card.resultTurnId===card.turnId))return chapter.paths.map((p,i)=>({...p,recommended:i===0}));
  const next = card.triage?.nextAction || card.draft?.decision || 'Review the latest result and identify the smallest useful next step.';
  const context = `For ${repoName(card)}, review the latest work in this existing task. The last recorded recommendation was: ${next}`;
  const boundary = ' Keep this bounded to the current repository. Do not deploy, publish, spend, commit, push, contact anyone, or change external accounts. Return the result and any remaining decision to me.';
  const needsInput = ['needs Adam','external blocker'].includes(card.triage?.disposition);
  const reusableDraft = !card.returned && !['Check my work','Try another route','My own direction'].includes(card.draft?.decision) && (!card.draft?.revision || card.draft.revision === card.revision) ? card.draft?.prompt : null;
  return [
    { title: needsInput ? 'Find a way forward' : 'Take the next step', description: excerpt(next, 90), prompt: needsInput ? `${context}\nIdentify the exact missing input and recommend a useful local step we can take while waiting. Do not assume my answer or authorization.${boundary}` : reusableDraft || `${context}\nComplete the smallest local step that is already authorized; if an owner decision is missing, explain it instead of assuming.${boundary}`, recommended: true },
    { title: 'Check my work', description: 'Test the last result before we build on it.', prompt: `${context}\nVerify the claims in the latest result against the actual files and focused checks. Report what holds up, what does not, and the most important gap. Make no implementation changes.${boundary}` },
    { title: 'Try another route', description: 'Find a smaller or more useful way to reach the goal.', prompt: `${context}\nReconsider this next step against the project's documented goal. Recommend one meaningfully different route, explain the tradeoff, and show the first bounded prompt. Planning only; do not start implementation.${boundary}` },
  ];
}
