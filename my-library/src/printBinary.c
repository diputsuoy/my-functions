#include <stdio.h>



void printBinary(int num) {

    for (int i = 31; i >= 0; i--) {

        printf("%d", (num >> i) & 1);

    }

    printf("\n");

}