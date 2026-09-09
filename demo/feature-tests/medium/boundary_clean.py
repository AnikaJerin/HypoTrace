def first_and_last(values):
    if not values:
        return None
    return values[0], values[-1]

assert first_and_last([4, 9]) == (4, 9)
