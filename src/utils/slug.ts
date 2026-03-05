import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Default OpenRouter model fallback list */
export const DEFAULT_OPENROUTER_MODELS = ['google/gemini-2.5-flash', 'x-ai/grok-4-fast:free', 'openai/gpt-4o-mini'];

/**
 * Build the model list: user-preferred model first, then defaults (deduped).
 * If no preferredModel is passed, reads from global settings (~/.dmux.global.json).
 */
export function getOpenRouterModels(preferredModel?: string): string[] {
  let model = preferredModel;
  if (!model) {
    try {
      const global = JSON.parse(readFileSync(join(homedir(), '.dmux.global.json'), 'utf-8'));
      model = global.openRouterModel;
    } catch {
      // No global settings or parse error
    }
  }
  if (!model) return DEFAULT_OPENROUTER_MODELS;
  return [model, ...DEFAULT_OPENROUTER_MODELS.filter(m => m !== model)];
}

export const callClaudeCode = async (prompt: string): Promise<string | null> => {
  try {
    const result = execSync(
      `echo "${prompt.replace(/"/g, '\\"')}" | claude --no-interactive --max-turns 1 2>/dev/null | head -n 5`,
      {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      }
    );
    const lines = result.trim().split('\n');
    const response = lines.join(' ').trim();
    return response || null;
  } catch {
    return null;
  }
};

export const generateSlug = async (prompt: string): Promise<string> => {
  if (!prompt) return `dmux-${Date.now()}`;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    const models = getOpenRouterModels();

    for (const model of models) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: `Generate a 1-2 word kebab-case slug for this prompt. Only respond with the slug, nothing else: "${prompt}"`
              }
            ],
            max_tokens: 10,
            temperature: 0.3
          })
        });

        if (response.ok) {
          const data = await response.json() as any;
          const slug = data.choices[0].message.content.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
          if (slug) return slug;
        }
      } catch {
        // Try next model
        continue;
      }
    }
  }

  const claudeResponse = await callClaudeCode(
    `Generate a 1-2 word kebab-case slug for this prompt. Only respond with the slug, nothing else: "${prompt}"`
  );
  if (claudeResponse) {
    const slug = claudeResponse.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (slug) return slug;
  }

  return `dmux-${Date.now()}`;
};
