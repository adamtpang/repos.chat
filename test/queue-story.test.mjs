import test from 'node:test';
import assert from 'node:assert/strict';
import { repoName, excerpt, pathsFor, statusLabel } from '../queue-ui/story.mjs';
test('story paths preserve exact recommendations and distinguish verification from planning', () => {
  const card = { checkout:{cwd:'C:\\fictional\\moon-garden'}, draft:{prompt:'Fix the local seed parser.'}, triage:{nextAction:'Repair the seed parser.',disposition:'ready'} };
  assert.equal(repoName(card),'moon-garden');
  const paths=pathsFor(card); assert.equal(paths.length,3); assert.equal(paths[0].prompt,card.draft.prompt);
  assert.match(paths[1].prompt,/Make no implementation changes/); assert.match(paths[2].prompt,/Planning only/);
});
test('blocked paths ask for missing input and do not reuse old executable drafts',()=>{
  const paths=pathsFor({title:'Fictional garden',triage:{disposition:'needs Adam',nextAction:'Choose a schedule'},draft:{prompt:'Start now'}});
  assert.match(paths[0].prompt,/Do not assume my answer or authorization/); assert.notEqual(paths[0].prompt,'Start now');
});
test('recaps are bounded source excerpts and failed returns are not complete',()=>{
  assert.equal(excerpt('**Checked** the [parser](https://example.com).'),'Checked the parser.');
  assert.ok(excerpt('word '.repeat(100),100).length<=101);
  assert.equal(statusLabel({returned:true,turnStatus:'failed'}),'Needs a hand');
  assert.equal(statusLabel({delivery:'uncertain',request:{status:'uncertain'}}),'Checking delivery');
});
test('returned and stale drafts cannot become the next recommended action',()=>{
  for(const card of [{returned:true},{revision:'new',draft:{revision:'old',prompt:'OLD'}},{draft:{decision:'Check my work',prompt:'OLD'}}]) {
    const input={draft:{prompt:'OLD'},...card}; assert.notEqual(pathsFor(input)[0].prompt,'OLD');
  }
});
