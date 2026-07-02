// src/api/functions.js

// TEMPORARY MIGRATION FILE
// Base44 functions have been disabled.
// Any code that tries to call these should be migrated to Supabase or Vercel functions.

const notImplemented = (name) => () => {
    throw new Error(`Base44 function "${name}" is not implemented. Migrate this feature to Supabase/Vercel.`);
  };
  
  export const syncMemberFromCRM = async (params) => {
    const response = await fetch('/api/functions/syncMemberFromCRM', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  
  export const syncEventsFromBackstage = async (params) => {
    const response = await fetch('/api/functions/syncEventsFromBackstage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  
  export const validateMember = async (params) => {
    const response = await fetch('/api/functions/validateMember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const refreshMemberBalance = async (params) => {
    const response = await fetch('/api/functions/refreshMemberBalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const syncBackstageEvents = async (params) => {
    const response = await fetch('/api/functions/syncBackstageEvents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const testFunction = notImplemented("testFunction");
  export const validateColleague = async (params) => {
    const response = await fetch('/api/functions/validateColleague', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const createBooking = async (params) => {
    const response = await fetch('/api/functions/createBooking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const processProgramTicketPurchase = async (params) => {
    const response = await fetch('/api/functions/processProgramTicketPurchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const sendMagicLink = async (params) => {
    const response = await fetch('/api/functions/sendMagicLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const verifyMagicLink = async (params) => {
    const response = await fetch('/api/functions/verifyMagicLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const updateExpiredVouchers = async (params) => {
    const response = await fetch('/api/functions/updateExpiredVouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {})
    });
    return response.json();
  };
  export const createStripePaymentIntent = async (params) => {
    const response = await fetch('/api/functions/createStripePaymentIntent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const getStripePublishableKey = async () => {
    const response = await fetch('/api/functions/getStripePublishableKey');
    return response.json();
  };
  export const getXeroAuthUrl = async () => {
    const response = await fetch('/api/functions/getXeroAuthUrl');
    return response.json();
  };
  export const xeroOAuthCallback = async (params) => {
    const queryParams = new URLSearchParams(params);
    const response = await fetch('/api/functions/xeroOAuthCallback?' + queryParams.toString());
    return response.json();
  };
  export const refreshXeroToken = async () => {
    const response = await fetch('/api/functions/refreshXeroToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return response.json();
  };
  export const createXeroInvoice = async (params) => {
    const response = await fetch('/api/functions/createXeroInvoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const validateUser = async (params) => {
    const response = await fetch('/api/functions/validateUser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const applyDiscountCode = async (params) => {
    const response = await fetch('/api/functions/applyDiscountCode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const debugBackstageEvent = notImplemented("debugBackstageEvent");
  export const processBackstageCancellation = async (params) => {
    const response = await fetch('/api/functions/processBackstageCancellation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const cancelBackstageOrder = async (params) => {
    const response = await fetch('/api/functions/cancelBackstageOrder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const cancelTicketViaFlow = async (params) => {
    const response = await fetch('/api/functions/cancelTicketViaFlow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const updateEventImage = async (params) => {
    const response = await fetch('/api/functions/updateEventImage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const updateProgramDetails = async (params) => {
    const response = await fetch('/api/functions/updateProgramDetails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const testEmailAddressInBackstage = notImplemented("testEmailAddressInBackstage");
  export const clearBookings = async (params) => {
    const response = await fetch('/api/functions/clearBookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {})
    });
    return response.json();
  };
  export const clearProgramTicketTransactions = async (params) => {
    const response = await fetch('/api/functions/clearProgramTicketTransactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {})
    });
    return response.json();
  };
  export const cancelProgramTicketTransaction = async (params) => {
    const response = await fetch('/api/functions/cancelProgramTicketTransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const reinstateProgramTicketTransaction = async (params) => {
    const response = await fetch('/api/functions/reinstateProgramTicketTransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const checkMemberStatusByEmail = async (params) => {
    const response = await fetch('/api/functions/checkMemberStatusByEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const createJobPostingMember = async (params) => {
    const response = await fetch('/api/functions/createJobPostingMember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const createJobPostingNonMember = async (params) => {
    const response = await fetch('/api/functions/createJobPostingNonMember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const handleJobPostingPaymentWebhook = async (params) => {
    const response = await fetch('/api/functions/handleJobPostingPaymentWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const createJobPostingPaymentIntent = async (params) => {
    const response = await fetch('/api/functions/createJobPostingPaymentIntent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const renameResourceSubcategory = async (params) => {
    const response = await fetch('/api/functions/renameResourceSubcategory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const generateMemberHandles = async (params) => {
    const response = await fetch('/api/functions/generateMemberHandles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const extractAndUploadFont = notImplemented("extractAndUploadFont");
  export const enableLoginForAllMembers = notImplemented("enableLoginForAllMembers");
  export const sendTeamMemberInvite = async (params) => {
    const response = await fetch('/api/functions/sendTeamMemberInvite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const exportAllData = async (params) => {
    const response = await fetch('/api/functions/exportAllData', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  };
  export const generateSitemap = async () => {
    const response = await fetch('/api/functions/generateSitemap');
    return response.text();
  };
  