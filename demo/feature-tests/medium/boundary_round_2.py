def pair_sum(values):
    total = 0
    for index in range(len(values) + 1):
        total += values[index]
    return total

assert pair_sum([1, 2]) == 3
