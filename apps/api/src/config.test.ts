import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_TTL_SECONDS,
  parseConfig,
  redactConfig,
  SECRET_ENV_KEYS,
} from './config.js';
import { ConfigError } from './errors.js';

const validEnv = {
  ADO_ORG_URL: 'https://dev.azure.com/expertgroup/',
  ADO_SERVICE_TOKEN: 'a-very-secret-pat-value',
  REDIS_URL: 'redis://cache.internal:6379',
  DATABASE_URL: 'postgres://board:hunter2@db.internal:5432/board',
};

describe('parseConfig', () => {
  it('parses a minimal valid environment and applies spec defaults', () => {
    const config = parseConfig(validEnv);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('info');
    expect(config.ado.orgUrl).toBe('https://dev.azure.com/expertgroup');
    expect(config.cache.ttlSeconds).toEqual(DEFAULT_CACHE_TTL_SECONDS);
    expect(config.sync.concurrency).toBe(2);
    expect(config.sync.rateBudgetPerMinute).toBe(200);
    expect(config.ado.requestTimeoutMs).toBeGreaterThan(0);
    expect(config.redis.requestTimeoutMs).toBeGreaterThan(0);
    expect(config.postgres.requestTimeoutMs).toBeGreaterThan(0);
    expect(config.http.requestTimeoutMs).toBeGreaterThan(0);
  });

  it('honours cache TTL overrides', () => {
    const config = parseConfig({
      ...validEnv,
      CACHE_TTL_BOARD_SNAPSHOT_SECONDS: '30',
      CACHE_TTL_COLUMN_MAPPING_SECONDS: '0',
    });
    expect(config.cache.ttlSeconds['board-snapshot']).toBe(30);
    expect(config.cache.ttlSeconds['column-mapping']).toBe(0);
  });

  it('reports every missing variable at once', () => {
    let thrown: unknown;
    try {
      parseConfig({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const issues = (thrown as ConfigError).issues.join('\n');
    for (const key of [
      'ADO_ORG_URL',
      'ADO_SERVICE_TOKEN',
      'REDIS_URL',
      'DATABASE_URL',
    ]) {
      expect(issues).toContain(key);
    }
    expect((thrown as ConfigError).issues).toHaveLength(4);
    expect((thrown as ConfigError).status).toBe(500);
    expect((thrown as ConfigError).code).toBe('invalid_configuration');
  });

  it('rejects a non-https org url and a non-redis cache url together', () => {
    const run = () =>
      parseConfig({
        ...validEnv,
        ADO_ORG_URL: 'http://dev.azure.com/expertgroup',
        REDIS_URL: 'http://cache.internal:6379',
      });
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues).toHaveLength(2);
    }
  });

  it('rejects a port outside the legal range', () => {
    expect(() => parseConfig({ ...validEnv, PORT: '70000' })).toThrow(
      ConfigError,
    );
  });

  it('rejects a non-numeric timeout with a readable message', () => {
    try {
      parseConfig({ ...validEnv, ADO_REQUEST_TIMEOUT_MS: 'soon' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).issues).toEqual([
        'ADO_REQUEST_TIMEOUT_MS: must be a whole number',
      ]);
    }
  });

  it('never echoes the value of a secret variable', () => {
    try {
      parseConfig({
        ...validEnv,
        ADO_SERVICE_TOKEN: 'tiny',
        DATABASE_URL: 'mysql://board:hunter2@db.internal:3306/board',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).not.toContain('tiny');
      expect(message).not.toContain('hunter2');
      for (const key of SECRET_ENV_KEYS.slice(0, 1)) {
        expect(message).toContain(`${key}: is missing or invalid`);
      }
    }
  });
});

describe('redactConfig', () => {
  it('keeps hosts and drops credentials', () => {
    const redacted = redactConfig(parseConfig(validEnv));
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('a-very-secret-pat-value');
    expect(serialised).not.toContain('hunter2');
    expect(redacted['postgresHost']).toBe('db.internal:5432');
    expect(redacted['adoOrgHost']).toBe('dev.azure.com');
  });
});
