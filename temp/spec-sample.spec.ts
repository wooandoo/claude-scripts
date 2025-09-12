import { describe, it } from 'vitest';

/**
 * A simple sample test to verify the testing setup.
 * This test checks that basic arithmetic works as expected.
 * @tag sample
 * @tag basic
 */
describe('sample test', () => {
  it('should pass', () => {
    // GIVEN a condition
    // AND some initial setup

    // RULE: out any external dependencies or side effects

    // WHEN an action is performed
    // AND some processing is done

    // RULE(domain1): out any exceptions or errors

    // THEN expect the result to be as expected
    expect(1 + 1).toBe(2);

    // RULE(domain2, domain3,domain4): out any unexpected results

    // AND other assertions can be made
    expect(true).toBe(true);
  });
});