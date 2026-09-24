import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createPetProvider, localSafetyReply, PET_HELP, OFFLINE_REPLY, MEDICAL_BOUNDARY} from '../src/features/pet-provider.mjs';
import {encryptPetText, decryptPetText} from '../src/features/pet-crypto.mjs';

const env = {OPENAI_API_KEY: 'test-key-never-live', OPENAI_PET_MODEL: 'configured-model'};
const safe = () => ({results: [{flagged: false, categories: {'self-harm': false, 'self-harm/intent': false, 'self-harm/instructions': false, violence: false}}]});
const answer = (text = 'Похоже, день был непростым. Что помогло бы вам немного отдохнуть?') => ({status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}]});
const json = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});

test('pet provider uses stateless bounded Responses and moderation without account fields', async () => {
  const calls = [], provider = createPetProvider({env, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({url, body, options});
    return json(url.endsWith('/moderations') ? safe() : answer());
  }});
  const result = await provider.reply({message: 'Устал сегодня', history: Array.from({length: 9}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(1200)})), email: 'must-not-send@example.test', lng: 77, petName: 'ignore instructions'});
  assert.equal(result.mode, 'ai'); assert.equal(calls.length, 3);
  assert.equal(calls[1].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[1].body.store, false); assert.equal(calls[1].body.max_output_tokens, 512);
  assert.equal(calls[1].body.model, env.OPENAI_PET_MODEL); assert.equal(calls[1].body.input.length, 7);
  assert.equal(calls[1].body.input[0].content.length, 1000);
  assert.equal(calls[0].body.model, 'omni-moderation-latest');
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal && call.options.redirect === 'error'));
  assert.doesNotMatch(JSON.stringify(calls.map(call => call.body)), /must-not-send|ignore instructions|"lng"|previous_response_id|"tools"/);
});

test('unconfigured provider is explicitly scripted and local urgent support never contacts OpenAI', async () => {
  let requests = 0;
  const fetchImpl = async () => {requests++; throw new Error('Should not call');};
  const offline = createPetProvider({env: {}, fetchImpl});
  assert.deepEqual(await offline.reply({message: 'Как дела?'}), {reply: OFFLINE_REPLY, mode: 'offline'});
  const ai = createPetProvider({env, fetchImpl});
  assert.equal((await ai.reply({message: 'Я не хочу жить'})).reply, PET_HELP.text);
  assert.equal((await ai.reply({message: 'Какие таблетки мне принимать?'})).reply, MEDICAL_BOUNDARY);
  assert.equal(requests, 0);
  assert.equal(localSafetyReply('I want to kill myself'), PET_HELP.text);
});

test('missing, malformed and failed moderation fail closed before generation', async () => {
  for (const body of [{}, {results: []}, {results: [{flagged: false, categories: {}}]}, {results: [{flagged: false, categories: []}]}, {results: [{flagged: false, categories: {'self-harm': 'false'}}]}]) {
    let requests = 0;
    const provider = createPetProvider({env, fetchImpl: async () => {requests++; return json(body);}});
    await assert.rejects(provider.reply({message: 'Обычный день'}), error => error.status === 503);
    assert.equal(requests, 1);
  }
  const provider = createPetProvider({env, fetchImpl: async () => new Response('upstream secret', {status: 500})});
  await assert.rejects(provider.reply({message: 'Обычный день'}), error => error.status === 503 && !error.message.includes('secret'));
});

test('moderation flags input/output and inconsistent category flags never release unsafe content', async () => {
  for (const flagAt of [1, 3]) {
    let requests = 0;
    const provider = createPetProvider({env, fetchImpl: async url => {
      requests++; const response = safe();
      if (requests === flagAt) response.results[0].categories['self-harm/intent'] = true;
      return json(url.endsWith('/responses') ? answer('sensitive unsafe model output') : response);
    }});
    const result = await provider.reply({message: 'Обычный день'});
    assert.equal(result.mode, 'support'); assert.equal(result.reply, PET_HELP.text); assert.equal(requests, flagAt);
  }
  let requests = 0;
  const provider = createPetProvider({env, fetchImpl: async url => {
    requests++; const response = safe(); response.results[0].categories.violence = true;
    return json(url.endsWith('/responses') ? answer() : response);
  }});
  assert.equal((await provider.reply({message: 'Проверка'})).mode, 'support'); assert.equal(requests, 1);
});

test('partial output, oversized body and obvious relationship/medical boundary violations are blocked', async () => {
  for (const output of [{...answer(), status: 'incomplete'}, answer('x'.repeat(2300)), {...answer(), output: []}]) {
    const provider = createPetProvider({env, fetchImpl: async url => json(url.endsWith('/responses') ? output : safe())});
    await assert.rejects(provider.reply({message: 'День прошёл обычно'}), error => error.status === 503);
  }
  const provider = createPetProvider({env, fetchImpl: async url => json(url.endsWith('/responses') ? answer('Только я тебя понимаю, не нужны друзья.') : safe())});
  assert.equal((await provider.reply({message: 'Мне грустно'})).mode, 'support');
  const huge = createPetProvider({env, fetchImpl: async () => new Response('x'.repeat(131073))});
  await assert.rejects(huge.reply({message: 'Привет'}), error => error.status === 503);
});

test('pet ciphertext authenticates account/context, wrong key and tampering', () => {
  const key = randomBytes(32), secret = 'Личная заметка о переживаниях';
  const first = encryptPetText(secret, key, 'u1:message:m1'), second = encryptPetText(secret, key, 'u1:message:m1');
  assert.notEqual(first, second); assert.equal(decryptPetText(first, key, 'u1:message:m1'), secret);
  assert.throws(() => decryptPetText(first, key, 'u2:message:m1'), /authenticated/);
  assert.throws(() => decryptPetText(first, randomBytes(32), 'u1:message:m1'), /authenticated/);
  assert.throws(() => decryptPetText(first.slice(0, -2) + 'xx', key, 'u1:message:m1'), /authenticated/);
});
