import test from 'node:test';
import assert from 'node:assert';
import autoContinuePlugin from './index.js';

test('gsd-auto-continue', async (t) => {
  const events = {};
  const notifications = [];
  const userMessages = [];
  
  const mockPi = {
    on: (eventName, handler) => {
      events[eventName] = handler;
    },
    sendUserMessage: (msg) => {
      userMessages.push(msg);
    },
    ui: {
      notify: (msg, type) => {
        notifications.push({ msg, type });
      }
    },
    tools: [
      {
        name: 'gsd_plan_milestone',
        execute: async (args) => {
          return { output: 'success' };
        }
      }
    ],
    core: {
      validateToolArguments: (tool, args) => {
        if (args.failValidation) {
          throw new Error('validation error');
        }
      }
    }
  };

  // Initialize plugin
  autoContinuePlugin(mockPi);

  await t.test('registers all required events', () => {
    assert.ok(events['unit_start'], 'should register unit_start');
    assert.ok(events['unit_end'], 'should register unit_end');
    assert.ok(events['notification'], 'should register notification');
    assert.ok(events['stop'], 'should register stop');
    assert.ok(events['tool_call'], 'should register tool_call');
    assert.ok(events['tool_execution_end'], 'should register tool_execution_end');
    assert.ok(events['before_agent_start'], 'should register before_agent_start');
  });

  await t.test('handles stop event with reason error (With-Context Continuation)', async () => {
    userMessages.length = 0;
    notifications.length = 0;
    
    // Simulate error notification
    events['notification']({ type: 'error', message: 'Something went wrong' });
    
    // Simulate stop event
    events['stop']({ reason: 'error', error: 'Stop error' });
    
    // The retry uses setTimeout, so we need to wait a bit
    await new Promise(resolve => setTimeout(resolve, 1100)); // First retry is 1000ms delay
    
    assert.strictEqual(userMessages.length, 1, 'should have sent one user message');
    assert.ok(userMessages[0].includes('Stop error'), 'message should contain the stop error');
    assert.ok(userMessages[0].includes('Something went wrong'), 'message should contain the notification error');
    assert.strictEqual(notifications.length, 1, 'should have sent one notification');
    assert.ok(notifications[0].msg.includes('attempt 1/5'), 'notification should mention attempt number');
  });

  await t.test('handles stop event with reason blocked (Without-Context Recovery)', () => {
    userMessages.length = 0;
    notifications.length = 0;
    
    events['stop']({ reason: 'blocked', message: 'User intervention required' });
    
    assert.strictEqual(userMessages.length, 1, 'should have sent one user message immediately');
    assert.ok(userMessages[0].includes('Auto-mode exited abnormally'), 'message should be without-context recovery format');
    assert.strictEqual(notifications.length, 1, 'should have sent one notification');
    assert.ok(notifications[0].msg.includes('without-context recovery'), 'notification should mention recovery loop');
  });

  await t.test('patches gsd_ tools and catches validation errors', async () => {
    // Trigger before_agent_start to patch tools
    events['before_agent_start']({});
    
    const patchedTool = mockPi.tools.find(t => t.name === 'gsd_plan_milestone');
    assert.ok(patchedTool.__patched, 'tool should be marked as patched');
    
    // Test normal execution
    const resultNormal = await patchedTool.execute({ someArg: 'value' });
    assert.strictEqual(resultNormal.output, 'success', 'should return original execution output');
    
    // Test validation failure
    const resultFail = await patchedTool.execute({ failValidation: true });
    assert.ok(resultFail.output.includes('[SEMANTIC VALIDATION FAILED]'), 'should catch error and return fake success with error message');
  });

  await t.test('decodes JSON strings for schema array fields before validation', async () => {
    events['before_agent_start']({});
    const patchedTool = mockPi.tools.find(t => t.name === 'gsd_plan_milestone');
    
    const result = await patchedTool.execute({ 
      slices: JSON.stringify([{ sliceId: 'S01', isSketch: true }]) 
    });
    
    assert.strictEqual(result.output, 'success', 'should parse JSON strings and execute normally');
  });

  await t.test('validates conditional requirements (integrationClosure) for full slices', async () => {
    events['before_agent_start']({});
    const patchedTool = mockPi.tools.find(t => t.name === 'gsd_plan_milestone');
    
    // Missing integrationClosure for full slice
    const resultFail = await patchedTool.execute({
      slices: [{ sliceId: 'S01', isSketch: false }]
    });
    assert.ok(resultFail.output.includes('[SEMANTIC VALIDATION FAILED]'), 'should fail if integrationClosure is missing for a full slice');
    assert.ok(resultFail.output.includes('integrationClosure is required'), 'should mention integrationClosure');

    // Sketch slice doesn't need integrationClosure
    const resultPassSketch = await patchedTool.execute({
      slices: [{ sliceId: 'S01', isSketch: true }]
    });
    assert.strictEqual(resultPassSketch.output, 'success', 'should pass if it is a sketch slice');

    // Full slice with integrationClosure
    const resultPassFull = await patchedTool.execute({
      slices: [{ sliceId: 'S01', isSketch: false, integrationClosure: 'verified' }]
    });
    assert.strictEqual(resultPassFull.output, 'success', 'should pass if full slice has integrationClosure');
  });
});
