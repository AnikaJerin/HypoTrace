def ways(steps):
    dp = [0] * (steps + 1)
    dp[0] = 1
    for step in range(1, steps):
        dp[step] = dp[step - 1] + (dp[step - 2] if step > 1 else 0)
    return dp[steps]

assert ways(3) == 3
