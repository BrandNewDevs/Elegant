import Testing
@testable import engine

@Suite struct ProgressThrottleTests {
    @Test func passesOnlyHigherWholePercents() {
        let throttle = ProgressThrottle()
        #expect(throttle.advance(to: 0))
        #expect(!throttle.advance(to: 0))
        #expect(throttle.advance(to: 1))
        #expect(!throttle.advance(to: 1))
        #expect(throttle.advance(to: 5))
        #expect(!throttle.advance(to: 3))
    }
}
