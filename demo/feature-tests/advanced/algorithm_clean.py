def fibonacci(number):
    first, second = 0, 1
    for _ in range(number):
        first, second = second, first + second
    return first

assert fibonacci(7) == 13
