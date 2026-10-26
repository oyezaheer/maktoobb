// The integration tests use real timers, so give slow machines (like a CI runner) some slack.
export default {
  test: {
    testTimeout: 30000,
    retry: 2,
  },
};
