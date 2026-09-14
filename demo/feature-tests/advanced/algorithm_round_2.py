def non_adjacent_max(values):
    return sum(value for value in values if value > 0)

assert non_adjacent_max([2, 1, 1, 2]) == 4
