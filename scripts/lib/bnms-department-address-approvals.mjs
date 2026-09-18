// User explicitly approved these original 27 August records on 2026-09-18,
// after reviewing matching-candidates.csv. Later duplicates are never changed.
// Candidate sets are pinned too: new ambiguities require another confirmation.
export const APPROVED_RESOLUTIONS = Object.freeze({
  organisations: {
    'University Hospital Coventry': {
      selectedId: 'bd2b845b-a8b7-49f8-ad1b-17c466c94f2f',
      candidateIds: [
        '445febff-bffc-4c66-87b7-b8369246cd23',
        'bd2b845b-a8b7-49f8-ad1b-17c466c94f2f',
      ],
    },
  },
  departments: {
    'Midland Metropolitan University Hospital::Radiology based Nuclear Medicine': {
      selectedId: '197b6854-fdc8-4ea0-b78d-e61d346bd1fc',
      candidateIds: [
        '197b6854-fdc8-4ea0-b78d-e61d346bd1fc',
        '78815a75-a597-42ea-94d8-dd0c6c3d281e',
      ],
    },
    'Royal United Hospital::Nuclear Medicine - Physics based': {
      selectedId: 'e2633069-3409-4146-b28c-148263acb7b3',
      candidateIds: [
        'cf7e7f81-3fb3-42bd-9872-1065e426c6a1',
        'e2633069-3409-4146-b28c-148263acb7b3',
      ],
    },
    'Scarborough Hospital::Nuclear Medicine Stand Alone': {
      selectedId: 'ad731b3d-c4bb-4f21-a58d-9ef85800a3ff',
      candidateIds: [
        '31eed8be-ad30-426b-9771-dde17af3495f',
        'ad731b3d-c4bb-4f21-a58d-9ef85800a3ff',
      ],
    },
  },
});