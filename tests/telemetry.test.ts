import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponseTelemetry } from '../src/gateway/telemetry.ts';

const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;
test('protocol parser handles split UTF-8 and CRLF, cumulative usage, and tool identity', () => {
  const tools: string[] = [];
  const p = new ResponseTelemetry('text/event-stream', (id) => tools.push(id));
  const bytes = Buffer.from(event({type:'message_start',message:{id:'msg_1',model:'test',usage:{input_tokens:4, output_tokens:1}}}) + event({type:'content_block_start',content_block:{type:'tool_use',id:'tool_1'}}) + event({type:'content_block_delta',delta:{text:'中文'}}) + event({type:'message_delta',usage:{output_tokens:10}}) + event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:20}}) + event({type:'message_stop'}));
  for (const byte of bytes) p.push(Buffer.from([byte]));
  p.end();
  assert.equal(p.complete, true);
  assert.equal(p.usageComplete, true);
  assert.equal(p.usage.outputTokens, 20);
  assert.equal(p.responseId, 'msg_1');
  assert.deepEqual(tools, ['tool_1']);
});

test('oversized content frames do not hide later error or usage events', () => {
  const p = new ResponseTelemetry('text/event-stream');
  p.push(Buffer.from(event({type:'content_block_delta',delta:{text:'x'.repeat(2*1024*1024)}}) + event({type:'error',error:{type:'overloaded_error',message:'PRIVATE'}})));
  p.end();
  assert.equal(p.error, 'overloaded_error');
  assert.equal(p.complete, false);
  assert.equal(JSON.stringify(p).includes('PRIVATE'), false);
});
