import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const tasks=JSON.parse(await readFile(new URL('config/concepts.json',root),'utf8'));
const source=tasks.find(t=>t.caseId==='CHAR-03'&&t.modelId==='openai/gpt-image-2.5-sunburst');
const modelIds=[...new Set(tasks.map(t=>t.modelId))];
await writeFile(new URL('config/selections.json',root),JSON.stringify({reason:'Operator selected all four families. Predeclared common OpenAI mascot source enables identical edit/final input bytes, independent of quality ranking. This is not an accepted production design.',sourceTaskIds:[source.taskId],modelIds},null,2));
