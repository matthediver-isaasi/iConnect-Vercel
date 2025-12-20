import OpenAI from 'openai';

const llmRateLimits = new Map();
const LLM_RATE_LIMIT = 10;
const LLM_RATE_WINDOW = 60000;

let openaiClient = null;

function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  
  if (!apiKey) {
    console.warn('[LLM] No OpenAI API key configured');
    return null;
  }
  
  openaiClient = new OpenAI({
    apiKey,
    ...(baseURL && { baseURL })
  });
  
  return openaiClient;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const rateData = llmRateLimits.get(clientIp);
    
    if (rateData) {
      if (now < rateData.resetTime) {
        if (rateData.count >= LLM_RATE_LIMIT) {
          return res.status(429).json({ 
            error: 'Too many requests. Please try again later.',
            is_safe: true
          });
        }
        rateData.count++;
      } else {
        llmRateLimits.set(clientIp, { count: 1, resetTime: now + LLM_RATE_WINDOW });
      }
    } else {
      llmRateLimits.set(clientIp, { count: 1, resetTime: now + LLM_RATE_WINDOW });
    }
    
    if (llmRateLimits.size > 1000) {
      for (const [ip, data] of llmRateLimits.entries()) {
        if (now > data.resetTime) {
          llmRateLimits.delete(ip);
        }
      }
    }
    
    const client = getOpenAIClient();
    
    if (!client) {
      console.warn('[LLM] No API key configured, skipping moderation');
      return res.json({ 
        is_safe: true,
        reason: '',
        warning: 'Content moderation unavailable'
      });
    }
    
    const { prompt, response_json_schema } = req.body;
    
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required and must be a string' });
    }
    
    if (prompt.length > 10000) {
      return res.status(400).json({ error: 'prompt exceeds maximum length of 10000 characters' });
    }
    
    const messages = [
      { role: 'user', content: prompt }
    ];
    
    const completionParams = {
      model: 'gpt-4o-mini',
      messages,
      max_completion_tokens: 1024,
    };
    
    if (response_json_schema) {
      completionParams.response_format = { type: 'json_object' };
    }
    
    const completion = await client.chat.completions.create(completionParams);
    
    const responseContent = completion.choices[0]?.message?.content || '';
    
    if (response_json_schema) {
      try {
        const jsonResponse = JSON.parse(responseContent);
        return res.json(jsonResponse);
      } catch (parseError) {
        console.error('[LLM] Failed to parse JSON response:', responseContent);
        return res.json({ response: responseContent });
      }
    }
    
    res.json({ response: responseContent });
  } catch (error) {
    console.error('[LLM] Error invoking LLM:', error);
    
    if (error.status === 429 || error.code === 'rate_limit_exceeded') {
      return res.status(429).json({ 
        error: 'OpenAI rate limit exceeded. Please try again in a few seconds.',
        is_safe: true,
        reason: ''
      });
    }
    
    if (error.status === 401 || error.code === 'invalid_api_key') {
      console.error('[LLM] Invalid API key');
      return res.json({ 
        is_safe: true,
        reason: '',
        warning: 'Content moderation unavailable - invalid API key'
      });
    }
    
    if (error.status === 403 || error.code === 'insufficient_quota') {
      console.error('[LLM] Insufficient quota');
      return res.json({ 
        is_safe: true,
        reason: '',
        warning: 'Content moderation unavailable - quota exceeded'
      });
    }
    
    console.error('[LLM] Unhandled error:', error.message, error.code, error.status);
    return res.json({ 
      is_safe: true,
      reason: '',
      warning: 'Content moderation temporarily unavailable',
      debug_error: error.message || String(error)
    });
  }
}
