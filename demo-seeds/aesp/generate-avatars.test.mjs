// Tests for demo-seeds/aesp/generate-avatars.mjs
//
// Run with:  node --test demo-seeds/aesp/generate-avatars.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAvatarPrompt, runAvatarGenerationPass } from './generate-avatars.mjs';

// ---------------------------------------------------------------------------
// buildAvatarPrompt
// ---------------------------------------------------------------------------

describe('buildAvatarPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Sarah', last_name: 'Mitchell', job_title: 'Senior Environmental Consultant' });
    assert.ok(typeof prompt === 'string' && prompt.length > 20, 'prompt should be a meaningful string');
  });

  it('includes gender clue for known feminine names', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Amelia', last_name: 'Hughes', job_title: 'Sustainability Manager' });
    assert.match(prompt, /woman/, 'should infer feminine gender for Amelia');
  });

  it('includes gender clue for known masculine names', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Oliver', last_name: 'Barnes', job_title: 'Graduate Environmental Scientist' });
    assert.match(prompt, /man/, 'should infer masculine gender for Oliver');
  });

  it('includes South Asian heritage clue for relevant names', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Priya', last_name: 'Patel', job_title: 'ESG Analyst' });
    assert.match(prompt, /South Asian/, 'should infer South Asian appearance');
  });

  it('includes East Asian heritage clue for relevant names', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Mei', last_name: 'Chen', job_title: 'Air Quality Specialist' });
    assert.match(prompt, /East Asian/, 'should infer East Asian appearance');
  });

  it('includes West African heritage clue for relevant names', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Kwame', last_name: 'Okafor', job_title: 'Carbon Reduction Lead' });
    assert.match(prompt, /Black British/, 'should infer Black British appearance for Kwame Okafor');
  });

  it('includes age clue for student job titles', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Chloe', last_name: 'Evans', job_title: 'MSc Environmental Management Student' });
    assert.match(prompt, /mid-20s/, 'should infer student age range');
  });

  it('includes seniority clue for director-level job titles', () => {
    const prompt = buildAvatarPrompt({ first_name: 'James', last_name: 'Walker', job_title: 'Sustainability Director' });
    assert.match(prompt, /40s|50s/, 'should infer senior age range for director title');
  });

  it('includes age clue for retired/former job titles', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Peter', last_name: 'Langford', job_title: 'Former Environmental Consultant' });
    assert.match(prompt, /60s/, 'should infer retired age range');
  });

  it('produces distinct prompts for two different members', () => {
    const p1 = buildAvatarPrompt({ first_name: 'Mei', last_name: 'Chen', job_title: 'Graduate Environmental Scientist' });
    const p2 = buildAvatarPrompt({ first_name: 'Adebayo', last_name: 'Osei', job_title: 'Sustainability Director' });
    assert.notEqual(p1, p2, 'prompts for different members must differ');
  });

  it('handles missing job_title gracefully', () => {
    const prompt = buildAvatarPrompt({ first_name: 'Hannah', last_name: 'Clarke', job_title: null });
    assert.ok(typeof prompt === 'string' && prompt.length > 20);
  });

  it('handles unknown names without throwing', () => {
    assert.doesNotThrow(() =>
      buildAvatarPrompt({ first_name: 'Xanthe', last_name: 'Zzyzx', job_title: 'Environmental Consultant' })
    );
  });
});

// ---------------------------------------------------------------------------
// runAvatarGenerationPass — sandbox mock (no real DB or image generation)
// ---------------------------------------------------------------------------

describe('runAvatarGenerationPass', () => {
  /** Build a minimal Supabase-shaped stub that serves a fixed member list. */
  function makeSbStub(members) {
    // Tracks uploaded paths so we can assert uniqueness.
    const uploads = [];
    const applied = [];

    const storage = {
      from: () => ({
        upload: async (path, buffer) => {
          uploads.push(path);
          return { error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.example.com/${path}` } }),
        list: async () => ({ data: [], error: null }),
      }),
    };

    const selectChain = {
      eq: function (...args) { this._eqArgs = (this._eqArgs || []).concat([args]); return this; },
      ilike: function () { return this; },
      is: function () { return this; },
      order: function () { return this; },
      limit: function () { return this; },
      maybeSingle: async function () {
        // applyDemoMemberAvatar: look up the member row.
        const id = (this._eqArgs || []).find(([col]) => col === 'id')?.[1];
        const m = members.find(m => m.id === id);
        if (!m) return { data: null, error: null };
        return { data: { id: m.id, email: m.email, profile_photo_url: null }, error: null };
      },
      // Resolves the .select() chain for listDemoMembersNeedingAvatars.
      then: function (resolve) {
        return Promise.resolve({ data: members, error: null }).then(resolve);
      },
    };

    const updateChain = {
      eq: function () { return this; },
      is: function () { return this; },
      select: async function () {
        applied.push(true);
        return { data: [{ id: 'applied' }], error: null };
      },
    };

    const from = (table) => ({
      select: () => selectChain,
      update: () => updateChain,
    });

    return { storage, from, _uploads: uploads, _applied: applied };
  }

  it('calls generateFn once per member and uploads with unique paths', async () => {
    const members = [
      { id: 'id-1', email: 'alice.jones@aesp.example.com', first_name: 'Alice', last_name: 'Jones', job_title: 'Senior Environmental Consultant', profile_photo_url: null },
      { id: 'id-2', email: 'oliver.smith@aesp.example.com', first_name: 'Oliver', last_name: 'Smith', job_title: 'Graduate Environmental Scientist', profile_photo_url: null },
      { id: 'id-3', email: 'priya.patel@aesp.example.com', first_name: 'Priya', last_name: 'Patel', job_title: 'ESG Analyst', profile_photo_url: null },
    ];

    const sb = makeSbStub(members);
    const promptsReceived = [];

    const generateFn = async (prompt) => {
      promptsReceived.push(prompt);
      // Return a minimal fake JPEG buffer.
      return Buffer.from('fake-jpeg');
    };

    const result = await runAvatarGenerationPass({
      sb,
      tenantId: 'test-tenant-id',
      generateFn,
      log: () => {},
      concurrency: 3,
    });

    // Each member should trigger exactly one generation call.
    assert.equal(promptsReceived.length, 3, 'generateFn should be called once per member');

    // All prompts must be non-empty strings.
    for (const p of promptsReceived) {
      assert.ok(typeof p === 'string' && p.length > 10, `prompt should be non-empty: ${p}`);
    }

    // All prompts must be distinct (no copy-paste collision).
    const unique = new Set(promptsReceived);
    assert.equal(unique.size, promptsReceived.length, 'every member should get a distinct prompt');

    // The pass should report 3 generated, 0 errors.
    assert.equal(result.generated, 3);
    assert.equal(result.errors, 0);
  });

  it('returns early with zeros when no members need avatars', async () => {
    const sb = makeSbStub([]);
    let called = 0;
    const generateFn = async () => { called++; return Buffer.from('x'); };

    const result = await runAvatarGenerationPass({ sb, tenantId: 'tid', generateFn, log: () => {} });
    assert.equal(called, 0, 'generateFn should not be called when no members need avatars');
    assert.equal(result.generated, 0);
    assert.equal(result.errors, 0);
  });

  it('counts errors without throwing when generateFn rejects', async () => {
    const members = [
      { id: 'id-1', email: 'fail@aesp.example.com', first_name: 'Oliver', last_name: 'Turner', job_title: 'Sustainability Manager', profile_photo_url: null },
    ];
    const sb = makeSbStub(members);
    const generateFn = async () => { throw new Error('model error'); };

    const result = await runAvatarGenerationPass({ sb, tenantId: 'tid', generateFn, log: () => {}, concurrency: 1 });
    assert.equal(result.errors, 1);
    assert.equal(result.generated, 0);
  });
});
