# Photo AI connection without copying a key

The owner-only Testing Lab photo endpoint can use OpenAI through Vercel AI Gateway using the deployment's OIDC identity. This is not the ChatGPT account or subscription.

Credential precedence (server only):
1. Existing OPENAI_API_KEY: unchanged direct OpenAI billing and endpoint.
2. Existing AI_GATEWAY_API_KEY: Vercel AI Gateway.
3. On Vercel only, x-vercel-oidc-token supplied to the current function request, then VERCEL_OIDC_TOKEN fallback: Vercel AI Gateway.

The OpenAI model remains gpt-4.1-mini unless XY_PHOTO_VISION_MODEL names another OpenAI model. Gateway model IDs are prefixed openai/. No fallback model or provider credential switch occurs after a rejected request.

Gateway usage consumes the Vercel team's existing AI credits under its existing billing settings. This change does not create an account, buy credits, enable auto top-up, or change spending limits. It cannot override disabled OIDC, an unactivated account, unavailable models, or exhausted credits. Those failures are reported rather than fabricated as detections.

The diagnostic GET is owner-only and does not make a billable request. configured means a credential is present, not that a model or credits have been verified. Only a successful Analyze result marks connectionVerified true. The photo remains an explicit user-selected upload; this endpoint performs no inventory, route, or XY writes, and does not save images to Snacky storage.

References:
- https://vercel.com/docs/ai-gateway/authentication-and-byok
- https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses
- https://vercel.com/docs/oidc
- https://vercel.com/docs/ai-gateway/pricing

Regression command:
node --experimental-strip-types --test scripts/test-photo-ai-connection.mjs scripts/test-owner-photo-gallery-lab.mjs

A passing mock test or build is not evidence of a successful live photo analysis. Verify from an authorized owner session after deployment. Never log a credential or paste it into chat.
