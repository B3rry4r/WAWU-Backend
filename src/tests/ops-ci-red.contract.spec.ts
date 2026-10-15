// OPS-CI red proof: this spec fails on purpose, on the throwaway branch
// wmt/OPS-CI-red only. It is never merged.
describe('ops-ci red proof', () => {
  it('fails so the suite job goes red', () => {
    expect(1 + 1).toBe(3);
  });
});
