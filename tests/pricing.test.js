import test from 'node:test';import assert from 'node:assert/strict';import {calculateFare} from '../src/pricing.js';
test('distance and duration are priced',()=>assert.equal(calculateFare({distanceMiles:10,durationMinutes:20}),28));
test('minimum fare applies',()=>assert.equal(calculateFare({distanceMiles:0,durationMinutes:0}),9));
test('rejects invalid input',()=>assert.throws(()=>calculateFare({distanceMiles:-1,durationMinutes:10})));
