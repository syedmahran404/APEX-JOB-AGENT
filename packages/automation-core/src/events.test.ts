import { describe, it, expect } from 'vitest';
import { Events, parseApplyEvent, isTerminalEvent, ApplyEvent } from './events.js';

describe('events (ApplyEvent taxonomy)', () => {
  it('constructors produce schema-valid events', () => {
    const samples = [
      Events.stepStarted('open', '2026-06-02T00:00:00.000Z'),
      Events.fieldFilled('phone', '+91-**-***-1234', 'qa_memory'),
      Events.questionEncountered('Expected salary?', 'number', true),
      Events.questionAnswered('q1', 'ai_generated', 'dec-1'),
      Events.screenshot('s3://x', 'review'),
      Events.captchaDetected('iframe:recaptcha', 'recaptcha'),
      Events.humanRequired('otp'),
      Events.submitted('http200+dom', 'ext-1'),
      Events.stepFailed('submit', 'network', true),
      Events.rateLimited(5000),
    ];
    for (const e of samples) {
      expect(() => ApplyEvent.parse(e)).not.toThrow();
    }
  });

  it('questionAnswered omits aiDecisionId when not provided (exactOptional safe)', () => {
    const e = Events.questionAnswered('q', 'qa_memory');
    expect('aiDecisionId' in e).toBe(false);
  });

  it('parseApplyEvent rejects malformed events', () => {
    expect(() => parseApplyEvent({ kind: 'nope' })).toThrow();
    expect(() => parseApplyEvent({ kind: 'submitted' })).toThrow(); // missing confirmation
  });

  it('isTerminalEvent flags submitted / non-recoverable failure / human-required', () => {
    expect(isTerminalEvent(Events.submitted('dom-only'))).toBe(true);
    expect(isTerminalEvent(Events.humanRequired('captcha'))).toBe(true);
    expect(isTerminalEvent(Events.stepFailed('s', 'r', false))).toBe(true);
    expect(isTerminalEvent(Events.stepFailed('s', 'r', true))).toBe(false);
    expect(isTerminalEvent(Events.stepStarted('s', 't'))).toBe(false);
  });
});
