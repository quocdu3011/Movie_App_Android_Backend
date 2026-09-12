export interface HttpServiceConfig {
  serviceName: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
}

export function loadHttpServiceConfig(
  serviceName: string,
  portVariable: string,
  defaultPort: number,
  env: NodeJS.ProcessEnv = process.env,
): HttpServiceConfig {
  const nodeEnv = env.NODE_ENV?.trim();
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be explicitly set to development, test, or production');
  }
  const rawPort = env[portVariable] ?? String(defaultPort);
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${portVariable} must be an integer from 1 to 65535`);
  }
  return { serviceName, port, nodeEnv };
}
