# Forecast opportunity: state the invariant before implementing.
def non_adjacent_max(values):
    previous_two = previous_one = 0
    for value in values:
        previous_two, previous_one = previous_one, max(previous_one, previous_two + value)
    return previous_one

assert non_adjacent_max([2, 1, 1, 2]) == 4
