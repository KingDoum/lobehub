export const BRANDING_LOGO_URL = '';
export const BRANDING_NAME = 'LobeHub';
export const DEFAULT_EMBEDDING_PROVIDER = 'openai';
// 可通过环境变量覆盖，无需重新构建镜像
// 设置 DEFAULT_MINI_MODEL 和 DEFAULT_MINI_PROVIDER 到 .env 即可
export const DEFAULT_MINI_MODEL = process.env.DEFAULT_MINI_MODEL || 'deepseek-v4-flash';
export const DEFAULT_MINI_PROVIDER = process.env.DEFAULT_MINI_PROVIDER || 'newapi';
export const DEFAULT_MODEL = 'deepseek-v4-pro';
export const DEFAULT_ONBOARDING_MODEL = 'gemini-3-flash-preview';
export const DEFAULT_ONBOARDING_PROVIDER = 'google';
export const DEFAULT_PROVIDER = 'deepseek';
export const ORG_NAME = 'LobeHub';
// mirrored from packages/business/const — model-bank gates the LobeHub
// provider entry on this flag; the OSS desktop build keeps it off
export const ENABLE_BUSINESS_FEATURES = false;