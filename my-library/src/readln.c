#include <stdio.h>



void readln(char* buffer, int size) {

    int i = 0;

    char ch;



    while ((ch = getchar()) != '\n' && ch != EOF && i < size - 1) {

        buffer[i++] = ch;

    }

    buffer[i] = '\0';

}